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

    server.tool(
      "upload_model_asset",
      "Crea un asset Model en Roblox usando Assets Open Cloud. Admite .rbxm y .rbxmx, crea el asset a nombre de un usuario o grupo y devuelve operationId para consultar el procesamiento con roblox_asset_operation. No publica una Place.",
      {
        file_name: z.string().min(1).max(255).regex(/\\.(rbxm|rbxmx)$/i),
        file_base64: z.string().min(1),
        display_name: z.string().min(1).max(50),
        description: z.string().max(1000).default(""),
        creator_user_id: z.string().regex(/^\\d+$/).optional(),
        creator_group_id: z.string().regex(/^\\d+$/).optional(),
      },
      async ({ file_name, file_base64, display_name, description, creator_user_id, creator_group_id }) => {
        try {
          const apiKey = process.env.ROBLOX_API_KEY;
          if (!apiKey) return textResult("Falta configurar ROBLOX_API_KEY en Vercel.");
          if (Boolean(creator_user_id) === Boolean(creator_group_id)) {
            return textResult("Debes indicar exactamente uno: creator_user_id o creator_group_id.");
          }
          const maxBytes = 20 * 1024 * 1024;
          if (file_base64.length > Math.ceil((maxBytes * 4) / 3) + 8 ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(file_base64) ||
              file_base64.length % 4 !== 0) {
            return textResult("file_base64 no es válido o supera el límite de 20 MiB.");
          }
          const bytes = Buffer.from(file_base64, "base64");
          if (!bytes.byteLength || bytes.byteLength > maxBytes) {
            return textResult("El archivo debe pesar entre 1 byte y 20 MiB.");
          }
          const name = file_name.toLowerCase();
          if (name.endsWith(".rbxmx")) {
            const prefix = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\\uFEFF/, "").trimStart();
            if (!prefix.startsWith("<?xml") && !prefix.startsWith("<roblox")) {
              return textResult("El archivo .rbxmx no parece ser XML de Roblox.");
            }
          }
          const creationContext = {
            creator: creator_user_id ? { userId: creator_user_id } : { groupId: creator_group_id },
          };
          const form = new FormData();
          form.append("request", JSON.stringify({
            assetType: "Model",
            displayName: display_name,
            description,
            creationContext,
          }));
          form.append("fileContent", new Blob([new Uint8Array(bytes)], { type: "model/x-rbxm" }), file_name);
          const response = await fetch("https://apis.roblox.com/assets/v1/assets", {
            method: "POST",
            headers: { "x-api-key": apiKey, "Accept": "application/json" },
            body: form,
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(45000),
          });
          const responseText = await response.text();
          let data: any;
          try { data = responseText ? JSON.parse(responseText) : null; }
          catch { data = responseText.slice(0, 4000); }
          if (!response.ok) {
            return textResult(JSON.stringify({ ok: false, status: response.status, data }));
          }
          return textResult(JSON.stringify({
            ok: true,
            status: response.status,
            fileName: file_name,
            sizeBytes: bytes.byteLength,
            assetType: "Model",
            operation: data,
            note: "La creación es asíncrona. Consulta operationId con roblox_asset_operation hasta que finalice.",
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult("No se pudo crear el modelo: " + message);
        }
      }
    );

    server.tool(
      "roblox_asset_operation",
      "Consulta el estado y resultado de una operación de creación o actualización de Assets Open Cloud mediante su operationId.",
      { operation_id: z.string().min(1).max(200) },
      async ({ operation_id }) => {
        try {
          const apiKey = process.env.ROBLOX_API_KEY;
          if (!apiKey) return textResult("Falta configurar ROBLOX_API_KEY en Vercel.");
          const response = await fetch(
            "https://apis.roblox.com/assets/v1/operations/" + encodeURIComponent(operation_id),
            { headers: { "x-api-key": apiKey, "Accept": "application/json" }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) }
          );
          const raw = await response.text();
          let data: unknown;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 8000); }
          return textResult(JSON.stringify({ ok: response.ok, status: response.status, data }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult("Error consultando la operación del asset: " + message);
        }
      }
    );

    server.tool(
      "roblox_api_request",
      "Cliente general de Roblox Open Cloud y endpoints oficiales de Roblox. Permite usar los permisos de ROBLOX_API_KEY en APIs de universos, DataStores, Memory Stores, Luau Execution, assets, grupos, usuarios, inventario, mensajería, analíticas, eventos y otros servicios. Solo acepta HTTPS en dominios oficiales roblox.com. Para POST, PUT, PATCH o DELETE debes establecer confirm_write=true.",
      {
        url: z.string().url(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        confirm_write: z.boolean().optional(),
      },
      async ({ url, method, query, body, confirm_write }) => {
        try {
          const apiKey = process.env.ROBLOX_API_KEY;
          if (!apiKey) return textResult("Falta configurar ROBLOX_API_KEY en Vercel.");

          const target = new URL(url);
          const host = target.hostname.toLowerCase();
          if (
            target.protocol !== "https:" ||
            (host !== "roblox.com" && !host.endsWith(".roblox.com")) ||
            target.username ||
            target.password ||
            (target.port && target.port !== "443") ||
            target.hash
          ) {
            return textResult("URL rechazada. Solo se permiten URLs HTTPS de dominios oficiales *.roblox.com, sin credenciales ni puertos personalizados.");
          }

          if (method !== "GET" && confirm_write !== true) {
            return textResult("Operación no ejecutada. Para autorizar una modificación, vuelve a llamar con confirm_write=true.");
          }

          if (query) {
            for (const [key, value] of Object.entries(query)) {
              target.searchParams.set(key, value);
            }
          }

          let requestBody: string | undefined;
          if (body !== undefined) {
            requestBody = JSON.stringify(body);
            if (new TextEncoder().encode(requestBody).byteLength > 1024 * 1024) {
              return textResult("El cuerpo JSON supera el límite de 1 MiB.");
            }
          }

          const response = await fetch(target, {
            method,
            headers: {
              "x-api-key": apiKey,
              "Accept": "application/json",
              ...(requestBody !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(requestBody !== undefined ? { body: requestBody } : {}),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(30000),
          });

          const responseText = await response.text();
          let responseData: unknown;
          try {
            responseData = responseText ? JSON.parse(responseText) : null;
          } catch {
            responseData = responseText.slice(0, 12000);
          }

          const result = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: target.toString(),
            method,
            data: responseData,
          };

          let serialized = JSON.stringify(result);
          if (serialized.length > 16000) {
            const preview = typeof responseData === "string"
              ? responseData.slice(0, 12000)
              : JSON.stringify(responseData).slice(0, 12000);
            serialized = JSON.stringify({
              ok: response.ok,
              status: response.status,
              statusText: response.statusText,
              url: target.toString(),
              method,
              truncated: true,
              dataPreview: preview,
              message: "La respuesta original superó el límite de 16000 caracteres; se devuelve una vista previa JSON válida.",
            });
          }
          return textResult(serialized);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult("Error al llamar la API de Roblox: " + message);
        }
      }
    );

    server.tool(
      "roblox_api_capabilities",
      "Muestra los grupos de permisos de la API key de Roblox que el usuario indicó que están habilitados. La API key real nunca se muestra.",
      {},
      async () => textResult([
        "Permisos comunicados como activos por el usuario:",
        "Assets y Creator Store: asset-permissions, assets, creator-store-products, creator-store-saves, thumbnails, universe-thumbnail.",
        "Monetización: developer-products, game-passes, subscriptions.",
        "Grupos y usuarios: groups, group-forums, users, inventory, user-restrictions, team-collaborations, followings.",
        "Universos y Places: universe, universes, universe-places, universe-place-instances.",
        "Datos y ejecución: universe-datastores, ordered-data-stores, memory-stores, messaging-service, luau-execution-sessions, secret-store.",
        "Analíticas y eventos: universe-analytics, universe-analytics-alert, universe-events, studio-evaluations.",
        "También se indicaron permisos legacy para assets, badges, developer-products, game-passes, groups, universes y users.",
        "",
        "Usa roblox_api_request para llamar los endpoints oficiales. Los permisos efectivos los valida Roblox; los endpoints legacy que requieran cookies no se vuelven compatibles con x-api-key por aparecer en la lista."
      ].join("\n"))
    );
  },
  {},
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
