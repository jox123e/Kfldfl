import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const value = address.toLowerCase();
  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
}

async function downloadPlaceFile(fileUrl: string): Promise<Uint8Array> {
  const url = new URL(fileUrl);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    isIP(url.hostname)
  ) {
    throw new Error("file_url debe ser una URL HTTPS pública, sin credenciales ni IP privada.");
  }

  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("El host de file_url no resuelve a una dirección pública.");
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new Error(`No se pudo descargar el archivo: HTTP ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_FILE_BYTES) {
    throw new Error("El archivo supera el límite de 10 MiB.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("El archivo descargado está vacío.");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("El archivo supera el límite de 10 MiB.");
  }
  return bytes;
}

function decodeInlineFile(base64: string): Uint8Array {
  if (base64.length > Math.ceil((MAX_INLINE_BYTES * 4) / 3) + 8) {
    throw new Error("Para archivos mayores de 3 MiB, usa file_url con una URL HTTPS pública.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error("file_base64 no contiene Base64 válido.");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) throw new Error("El archivo está vacío.");
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new Error("La carga Base64 está limitada a 3 MiB; usa file_url para archivos mayores.");
  }
  return new Uint8Array(bytes);
}

function validatePlaceFile(fileName: string, bytes: Uint8Array): "application/xml" | "application/octet-stream" {
  const name = fileName.toLowerCase();

  if (name.endsWith(".rbxlx")) {
    const prefix = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, "").trimStart();
    if (!prefix.startsWith("<?xml") && !prefix.startsWith("<roblox")) {
      throw new Error("El archivo .rbxlx no parece contener XML de Roblox válido.");
    }
    return "application/xml";
  }

  if (name.endsWith(".rbxl")) {
    return "application/octet-stream";
  }

  throw new Error("Formato no admitido. Usa un archivo .rbxl o .rbxlx.");
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "upload_place",
      "Sube un archivo .rbxl o .rbxlx al Place indicado y lo publica inmediatamente. Roblox registra internamente una nueva versión publicada. Usa file_base64 para archivos de hasta 3 MiB o file_url para archivos de hasta 10 MiB alojados en una URL HTTPS pública.",
      {
        file_name: z.string().min(1).max(255),
        file_base64: z.string().optional(),
        file_url: z.string().url().optional(),
        place_id: z.string().regex(/^\d+$/).optional(),
      },
      async ({ file_name, file_base64, file_url, place_id }) => {
        try {
          if (Boolean(file_base64) === Boolean(file_url)) {
            return textResult("Debes proporcionar exactamente uno: file_base64 o file_url.");
          }

          const universeId = process.env.ROBLOX_UNIVERSE_ID;
          const targetPlaceId = place_id || process.env.ROBLOX_PLACE_ID;
          const apiKey = process.env.ROBLOX_API_KEY;

          if (!universeId || !targetPlaceId || !apiKey) {
            return textResult("Falta configurar ROBLOX_UNIVERSE_ID, ROBLOX_PLACE_ID o ROBLOX_API_KEY en el entorno de Vercel.");
          }

          const bytes = file_url
            ? await downloadPlaceFile(file_url)
            : decodeInlineFile(file_base64!);

          const contentType = validatePlaceFile(file_name, bytes);
          const endpoint =
            `https://apis.roblox.com/universes/v1/${encodeURIComponent(universeId)}/places/${encodeURIComponent(targetPlaceId)}/versions?versionType=Published`;

          const requestBody = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(requestBody).set(bytes);

          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "Content-Type": contentType,
            },
            body: requestBody,
            cache: "no-store",
            signal: AbortSignal.timeout(45000),
          });

          const responseText = await response.text();
          let responseData: { versionNumber?: number; [key: string]: unknown };
          try {
            responseData = JSON.parse(responseText);
          } catch {
            responseData = { message: responseText.slice(0, 1500) };
          }

          if (!response.ok) {
            return textResult(
              `Roblox rechazó la publicación. HTTP ${response.status}. Respuesta: ${JSON.stringify(responseData)}`
            );
          }

          const versionNumber = responseData.versionNumber;
          return textResult(
            `Place publicado correctamente. Universe ID: ${universeId}. Place ID: ${targetPlaceId}. Archivo: ${file_name}. Tamaño: ${bytes.byteLength} bytes. Versión publicada por Roblox: ${versionNumber ?? "confirmada"}.`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`No se pudo publicar el Place: ${message}`);
        }
      }
    );
  },
  {
    name: "Roblox MCP",
    version: "1.0.0",
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

async function guarded(req: Request) {
  const token = process.env.MCP_AUTH_TOKEN;
  const given =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("token");

  if (!token || given !== token) {
    return new Response("Unauthorized", { status: 401 });
  }

  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
