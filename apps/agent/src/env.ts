import { config } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// El .env vive en la raíz del monorepo para compartirlo entre apps.
const root = resolve(fileURLToPath(import.meta.url), "../../../..");
config({ path: resolve(root, ".env") });

/**
 * Un VAULT_PATH que apunta a una carpeta que ya no existe (vault borrado o
 * movido, .env copiado de otra máquina) es peor que uno vacío: sin esto
 * quedaba "configurado" pero inválido, y `agent/session.ts`/`chat-history.ts`
 * lo usan como `cwd` de CADA turno sin proyecto en foco — spawnear con un cwd
 * que no existe hace fallar el `claude` nativo con ENOENT, con un mensaje que
 * habla de compatibilidad de binario y no menciona el vault para nada. Se
 * detectó así: TODO chat general se rompía en producción, reproducible hasta
 * en un turno aislado, con el binario funcionando perfecto invocado a mano.
 * Tratarlo como "" (sin vault) cae directo en el fallback ya existente
 * (`env.VAULT_PATH || process.cwd()`) sin tocar cada call site.
 */
const rawVaultPath = process.env.VAULT_PATH || "";
if (rawVaultPath && !existsSync(rawVaultPath)) {
  console.warn(
    `[env] VAULT_PATH="${rawVaultPath}" no existe — se trata como sin vault (cae a process.cwd()).`,
  );
}
const vaultPath = rawVaultPath && existsSync(rawVaultPath) ? rawVaultPath : "";

export const env = {
  PORT: Number(process.env.HERMES_PORT || 8642),
  VAULT_PATH: vaultPath,
  CLAWD_PATH: process.env.CLAWD_PATH || "",
  MACHINE_NAME: process.env.MACHINE_NAME || "local",
  HERMES_API_KEY: process.env.HERMES_API_KEY || "",
  // Multi-máquina: dirección con la que OTROS PCs de la red alcanzan a este
  // agente. Sin ella se deriva de la IP LAN real (presence.ts) — se pone a
  // mano solo si hay un nombre/puerto de por medio (Tailscale, reverse proxy).
  PUBLIC_URL: (process.env.HERMES_PUBLIC_URL || "").replace(/\/$/, ""),
  // Portal separado (Vercel u otro host público): orígenes EXACTOS admitidos
  // por CORS además de la LAN/Tailscale (coma-separados — ej. el dominio de
  // producción y el de cada preview que se quiera probar). Vacío = ningún
  // origen público puede llamar al agente, solo la LAN.
  PORTAL_ORIGINS: (process.env.HERMES_PORTAL_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
  // Raíz de los clones de código EN ESTA máquina. El vault guarda ruta_local
  // con las rutas de la Mac; en otro PC el mismo proyecto vive en otra parte,
  // así que los runs lo buscan aquí por nombre de carpeta antes de rendirse.
  CODE_ROOT: process.env.HERMES_CODE_ROOT || resolve(homedir(), "dev"),
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  // ── Embeddings: proveedor intercambiable ──────────────────────────────
  // "openai"  → text-embedding-3-small, 1536 dims, columnas `embedding`.
  // "ollama"  → modelo local (default nomic-embed-text, 768), columnas
  //             `embedding_local` y RPCs `*_local` (migración 025).
  // "none"    → sin vectores; la búsqueda cae a recencia/ILIKE.
  // Los dos esquemas conviven en la MISMA base: el servidor puede usar
  // embeddings locales sin romper la Mac, que sigue en 1536. pgvector no
  // compara dimensiones distintas, así que cada uno ve solo su índice.
  EMBEDDINGS_PROVIDER: (process.env.EMBEDDINGS_PROVIDER || "").toLowerCase(),
  OLLAMA_URL: (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  // STT del dictado del composer: ElevenLabs Scribe con fallback a Whisper.
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  // Proveedor de STT preferido: "whisper" | "scribe". Default: scribe primero,
  // Whisper de fallback. Ponlo en "whisper" si ElevenLabs se queda sin
  // créditos para no gastar la llamada fallida a Scribe.
  STT_PROVIDER: (process.env.HERMES_STT || "").toLowerCase(),
  // Búsqueda web EN VIVO del agente (tool `web_search`): proveedor
  // intercambiable, mismo patrón que EMBEDDINGS_PROVIDER — hoy "tavily" es
  // el único, pensado para poder sumar Exa/Brave/SearXNG o un motor propio
  // open source sin tocar la tool ni el prompt (ver websearch/index.ts).
  WEBSEARCH_PROVIDER: (process.env.WEBSEARCH_PROVIDER || "tavily").toLowerCase(),
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || "",
  // Fecha/hora/lugar actuales (ver temporal.ts): HERMES_TZ es una zona IANA
  // ("America/Bogota"); vacía cae a la del sistema operativo. HERMES_LOCATION
  // es texto libre para mostrar, no GPS en vivo.
  HERMES_TZ: process.env.HERMES_TZ || "",
  HERMES_LOCATION: process.env.HERMES_LOCATION || "",
  // Búsqueda de imágenes: mismo patrón intercambiable que WEBSEARCH_PROVIDER
  // — hoy Pexafy (ver imagesearch/index.ts).
  IMAGESEARCH_PROVIDER: (process.env.IMAGESEARCH_PROVIDER || "pexafy").toLowerCase(),
  PEXAFY_API_KEY: process.env.PEXAFY_API_KEY || "",
};

export const REPO_ROOT = root;
