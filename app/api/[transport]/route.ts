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
      "Crea un asset Model en Roblox usando Assets Open Cloud. Admite .rbxm y .rbxmx de hasta 10 MiB por file_url HTTPS público o 3 MiB por file_base64. Crea el asset a nombre de un usuario o grupo y devuelve operationId para consultar el procesamiento con roblox_asset_operation. No publica una Place.",
      {
        file_name: z.string().min(1).max(255).regex(/\.(rbxm|rbxmx)$/i),
        file_base64: z.string().min(1).optional(),
        file_url: z.string().url().optional(),
        display_name: z.string().min(1).max(50),
        description: z.string().max(1000).default(""),
        creator_user_id: z.string().regex(/^\d+$/).optional(),
        creator_group_id: z.string().regex(/^\d+$/).optional(),
      },
      async ({ file_name, file_base64, file_url, display_name, description, creator_user_id, creator_group_id }) => {
        try {
          const apiKey = process.env.ROBLOX_API_KEY;
          if (!apiKey) return textResult("Falta configurar ROBLOX_API_KEY en Vercel.");
          if (Boolean(creator_user_id) === Boolean(creator_group_id)) {
            return textResult("Debes indicar exactamente uno: creator_user_id o creator_group_id.");
          }
          if (Boolean(file_base64) === Boolean(file_url)) {
            return textResult("Debes proporcionar exactamente uno: file_base64 o file_url.");
          }
          let bytes: Uint8Array;
          if (file_url) {
            bytes = await downloadPlaceFile(file_url);
          } else {
            const maxInlineBytes = 3 * 1024 * 1024;
            if (file_base64!.length > Math.ceil((maxInlineBytes * 4) / 3) + 8 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(file_base64!) ||
                file_base64!.length % 4 !== 0) {
              return textResult("file_base64 no es válido o supera el límite de 3 MiB. Usa file_url para archivos mayores.");
            }
            bytes = new Uint8Array(Buffer.from(file_base64!, "base64"));
            if (!bytes.byteLength || bytes.byteLength > maxInlineBytes) {
              return textResult("El archivo debe pesar entre 1 byte y 3 MiB usando file_base64.");
            }
          }
          const name = file_name.toLowerCase();
          if (name.endsWith(".rbxmx")) {
            const prefix = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, "").trimStart();
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


    // Persistent Supabase Storage tools. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
    function storageConfig() {
      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!base || !key) throw new Error("Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Vercel.");
      const parsed = new URL(base);
      if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co")) {
        throw new Error("SUPABASE_URL debe ser el dominio HTTPS oficial del proyecto Supabase.");
      }
      return { base: parsed.origin, key, bucket: process.env.SUPABASE_STORAGE_BUCKET || "mcp-files" };
    }
    function safeStoragePath(value: string) {
      const path = value.replace(/^\/+/, "");
      if (!path || path.length > 900 || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Ruta de archivo inválida.");
      }
      return path;
    }
    async function storageRequest(path: string, init: RequestInit = {}) {
      const cfg = storageConfig();
      const response = await fetch(cfg.base + "/storage/v1" + path, {
        ...init,
        headers: {
          "apikey": cfg.key,
          "Authorization": "Bearer " + cfg.key,
          ...(init.headers || {}),
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      const raw = await response.text();
      let data: unknown;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 4000); }
      if (!response.ok) throw new Error("Supabase Storage HTTP " + response.status + ": " + JSON.stringify(data).slice(0, 3000));
      return data;
    }

    server.tool(
      "storage_upload",
      "Guarda un archivo de forma persistente en el bucket privado de Supabase. Acepta Base64 de hasta 5 MiB y una ruta relativa.",
      {
        path: z.string().min(1).max(900),
        file_base64: z.string().min(1),
        content_type: z.string().max(150).default("application/octet-stream"),
        overwrite: z.boolean().default(false),
      },
      async ({ path, file_base64, content_type, overwrite }) => {
        try {
          const clean = safeStoragePath(path);
          if (file_base64.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file_base64) || file_base64.length % 4 !== 0) {
            return textResult("Base64 inválido o demasiado grande (máximo 5 MiB).");
          }
          const bytes = Buffer.from(file_base64, "base64");
          if (!bytes.length || bytes.length > 5 * 1024 * 1024) return textResult("El archivo debe pesar entre 1 byte y 5 MiB.");
          const cfg = storageConfig();
          const objectPath = clean.split("/").map(encodeURIComponent).join("/");
          const result = await storageRequest("/object/" + encodeURIComponent(cfg.bucket) + "/" + objectPath, {
            method: "POST",
            headers: { "Content-Type": content_type, "x-upsert": String(overwrite) },
            body: new Uint8Array(bytes),
          });
          return textResult(JSON.stringify({ ok: true, bucket: cfg.bucket, path: clean, sizeBytes: bytes.length, result }));
        } catch (error) { return textResult("storage_upload: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "storage_download",
      "Descarga un archivo del almacenamiento persistente y devuelve su contenido en Base64. Máximo 3 MiB para evitar respuestas MCP excesivas.",
      { path: z.string().min(1).max(900) },
      async ({ path }) => {
        try {
          const clean = safeStoragePath(path);
          const cfg = storageConfig();
          const objectPath = clean.split("/").map(encodeURIComponent).join("/");
          const response = await fetch(cfg.base + "/storage/v1/object/" + encodeURIComponent(cfg.bucket) + "/" + objectPath, {
            headers: { apikey: cfg.key, Authorization: "Bearer " + cfg.key },
            cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) return textResult("Supabase Storage HTTP " + response.status + ".");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > 3 * 1024 * 1024) return textResult("El archivo supera el límite de descarga MCP de 3 MiB. Usa una URL firmada o descárgalo desde Supabase.");
          return textResult(JSON.stringify({ ok: true, path: clean, contentType: response.headers.get("content-type") || "application/octet-stream", sizeBytes: bytes.byteLength, file_base64: Buffer.from(bytes).toString("base64") }));
        } catch (error) { return textResult("storage_download: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "storage_list",
      "Lista archivos del bucket privado de Supabase bajo un prefijo opcional.",
      { prefix: z.string().max(900).default(""), limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().min(0).default(0) },
      async ({ prefix, limit, offset }) => {
        try {
          const cleanPrefix = prefix ? safeStoragePath(prefix) : "";
          const cfg = storageConfig();
          const data = await storageRequest("/object/list/" + encodeURIComponent(cfg.bucket), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix: cleanPrefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
          });
          return textResult(JSON.stringify({ ok: true, bucket: cfg.bucket, prefix: cleanPrefix, files: data }));
        } catch (error) { return textResult("storage_list: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "storage_delete",
      "Elimina permanentemente uno o varios archivos del bucket privado. Requiere confirm_delete=true.",
      { paths: z.array(z.string().min(1).max(900)).min(1).max(100), confirm_delete: z.boolean() },
      async ({ paths, confirm_delete }) => {
        try {
          if (!confirm_delete) return textResult("No se eliminó nada. Repite con confirm_delete=true.");
          const cfg = storageConfig();
          const clean = paths.map(safeStoragePath);
          const data = await storageRequest("/object/" + encodeURIComponent(cfg.bucket), {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefixes: clean }),
          });
          return textResult(JSON.stringify({ ok: true, deleted: clean, result: data }));
        } catch (error) { return textResult("storage_delete: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "storage_move",
      "Mueve o renombra un archivo dentro del mismo bucket privado.",
      { from_path: z.string().min(1).max(900), to_path: z.string().min(1).max(900), overwrite: z.boolean().default(false) },
      async ({ from_path, to_path, overwrite }) => {
        try {
          const cfg = storageConfig();
          const from = safeStoragePath(from_path), to = safeStoragePath(to_path);
          const data = await storageRequest("/object/move", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bucketId: cfg.bucket, sourceKey: from, destinationKey: to, destinationBucket: cfg.bucket, upsert: overwrite }),
          });
          return textResult(JSON.stringify({ ok: true, from, to, result: data }));
        } catch (error) { return textResult("storage_move: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "storage_copy",
      "Copia un archivo dentro del mismo bucket privado.",
      { from_path: z.string().min(1).max(900), to_path: z.string().min(1).max(900), overwrite: z.boolean().default(false) },
      async ({ from_path, to_path, overwrite }) => {
        try {
          const cfg = storageConfig();
          const from = safeStoragePath(from_path), to = safeStoragePath(to_path);
          const data = await storageRequest("/object/copy", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bucketId: cfg.bucket, sourceKey: from, destinationKey: to, destinationBucket: cfg.bucket, upsert: overwrite }),
          });
          return textResult(JSON.stringify({ ok: true, from, to, result: data }));
        } catch (error) { return textResult("storage_copy: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    // GitHub repository file tools. Configure GITHUB_TOKEN; writes require explicit confirmation.
    function githubConfig() {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error("Configura GITHUB_TOKEN en Vercel.");
      return { token, repo: process.env.GITHUB_REPOSITORY || "jox123e/Kfldfl" };
    }
    function safeRepoPath(value: string) {
      const path = value.replace(/^\/+/, "");
      if (!path || path.length > 900 || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Ruta de repositorio inválida.");
      return path;
    }
    async function githubRequest(path: string, init: RequestInit = {}) {
      const cfg = githubConfig();
      const response = await fetch("https://api.github.com/repos/" + cfg.repo + path, {
        ...init,
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + cfg.token, "X-GitHub-Api-Version": "2022-11-28", ...(init.headers || {}) },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25000),
      });
      const raw = await response.text();
      let data: any;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 4000); }
      if (!response.ok) throw new Error("GitHub HTTP " + response.status + ": " + JSON.stringify(data).slice(0, 2500));
      return data;
    }

    server.tool(
      "github_file_read",
      "Lee un archivo del repositorio GitHub configurado. Devuelve texto y SHA del contenido.",
      { path: z.string().min(1).max(900), branch: z.string().max(255).default("main") },
      async ({ path, branch }) => {
        try {
          const data = await githubRequest("/contents/" + safeRepoPath(path).split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch));
          if (Array.isArray(data) || data.type !== "file") return textResult("La ruta no es un archivo individual.");
          const decoded = Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
          return textResult(JSON.stringify({ ok: true, path, branch, sha: data.sha, content: decoded }));
        } catch (error) { return textResult("github_file_read: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "github_file_write",
      "Crea o reemplaza un archivo en GitHub. Requiere confirm_write=true. Para actualizar, proporciona el SHA actual obtenido con github_file_read.",
      { path: z.string().min(1).max(900), content: z.string().max(500000), message: z.string().min(1).max(200), branch: z.string().max(255).default("main"), sha: z.string().optional(), confirm_write: z.boolean() },
      async ({ path, content, message, branch, sha, confirm_write }) => {
        try {
          if (!confirm_write) return textResult("No se escribió nada. Repite con confirm_write=true.");
          const clean = safeRepoPath(path);
          const data = await githubRequest("/contents/" + clean.split("/").map(encodeURIComponent).join("/"), {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) }),
          });
          return textResult(JSON.stringify({ ok: true, path: clean, branch, commit: data.commit?.sha, contentSha: data.content?.sha }));
        } catch (error) { return textResult("github_file_write: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "github_file_delete",
      "Elimina un archivo de GitHub. Requiere el SHA actual y confirm_delete=true.",
      { path: z.string().min(1).max(900), sha: z.string().min(1), message: z.string().min(1).max(200), branch: z.string().max(255).default("main"), confirm_delete: z.boolean() },
      async ({ path, sha, message, branch, confirm_delete }) => {
        try {
          if (!confirm_delete) return textResult("No se eliminó nada. Repite con confirm_delete=true.");
          const data = await githubRequest("/contents/" + safeRepoPath(path).split("/").map(encodeURIComponent).join("/"), {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, sha, branch }),
          });
          return textResult(JSON.stringify({ ok: true, path, branch, commit: data.commit?.sha }));
        } catch (error) { return textResult("github_file_delete: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "github_repo_tree",
      "Lista el árbol de archivos de una rama del repositorio GitHub configurado.",
      { branch: z.string().max(255).default("main"), path_prefix: z.string().max(900).default("") },
      async ({ branch, path_prefix }) => {
        try {
          const ref = await githubRequest("/git/ref/heads/" + encodeURIComponent(branch));
          const tree = await githubRequest("/git/trees/" + encodeURIComponent(ref.object.sha) + "?recursive=1");
          const prefix = path_prefix ? safeRepoPath(path_prefix).replace(/\/$/, "") + "/" : "";
          const entries = (tree.tree || []).filter((entry: any) => !prefix || entry.path.startsWith(prefix)).map((entry: any) => ({ path: entry.path, type: entry.type, size: entry.size, sha: entry.sha }));
          return textResult(JSON.stringify({ ok: true, branch, truncated: tree.truncated, entries: entries.slice(0, 1000) }));
        } catch (error) { return textResult("github_repo_tree: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    // Roblox place metadata tools use documented Creator Hub endpoints.
    server.tool(
      "roblox_list_places",
      "Lista los Places de un universo usando el endpoint público documentado de Roblox. Permite paginación mediante cursor.",
      { universe_id: z.string().regex(/^\d+$/).optional(), limit: z.number().int().min(10).max(100).default(100), cursor: z.string().optional() },
      async ({ universe_id, limit, cursor }) => {
        try {
          const id = universe_id || process.env.ROBLOX_UNIVERSE_ID;
          if (!id) return textResult("Indica universe_id o configura ROBLOX_UNIVERSE_ID.");
          const url = new URL("https://develop.roblox.com/v1/universes/" + encodeURIComponent(id) + "/places");
          url.searchParams.set("limit", String(limit));
          if (cursor) url.searchParams.set("cursor", cursor);
          const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000) });
          const raw = await response.text();
          let data: unknown; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 5000); }
          return textResult(JSON.stringify({ ok: response.ok, status: response.status, universeId: id, data }));
        } catch (error) { return textResult("roblox_list_places: " + (error instanceof Error ? error.message : String(error))); }
      }
    );

    server.tool(
      "roblox_get_place",
      "Obtiene metadatos de un Place mediante Roblox Open Cloud v2.",
      { place_id: z.string().regex(/^\d+$/), universe_id: z.string().regex(/^\d+$/).optional() },
      async ({ place_id, universe_id }) => {
        try {
          const id = universe_id || process.env.ROBLOX_UNIVERSE_ID;
          const key = process.env.ROBLOX_API_KEY;
          if (!id || !key) return textResult("Configura ROBLOX_UNIVERSE_ID y ROBLOX_API_KEY o proporciona universe_id.");
          const response = await fetch("https://apis.roblox.com/cloud/v2/universes/" + encodeURIComponent(id) + "/places/" + encodeURIComponent(place_id), {
            headers: { "x-api-key": key, Accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
          });
          const raw = await response.text();
          let data: unknown; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 5000); }
          return textResult(JSON.stringify({ ok: response.ok, status: response.status, data }));
        } catch (error) { return textResult("roblox_get_place: " + (error instanceof Error ? error.message : String(error))); }
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
        "Herramientas dedicadas: upload_place (.rbxl/.rbxlx), upload_model_asset (.rbxm/.rbxmx), roblox_asset_operation (seguimiento de carga). roblox_api_request permite explorar otros endpoints oficiales compatibles con API key. Los permisos efectivos los valida Roblox; los endpoints legacy que requieran cookies no se vuelven compatibles con x-api-key por aparecer en la lista."
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
  const configuredToken = process.env.MCP_AUTH_TOKEN?.trim();
  const authorization = req.headers.get("authorization");
  const headerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const queryToken = new URL(req.url).searchParams.get("token")?.trim();
  const given = headerToken || queryToken;

  if (!configuredToken) {
    return new Response("MCP_AUTH_TOKEN is not configured for this deployment.", { status: 500 });
  }

  if (!given) {
    return new Response("Authorization token is missing.", { status: 401 });
  }

  if (given !== configuredToken) {
    return new Response("Authorization token mismatch.", { status: 401 });
  }

  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
