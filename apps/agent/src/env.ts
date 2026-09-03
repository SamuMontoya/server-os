import { config } from "dotenv";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// El .env vive en la raíz del monorepo para compartirlo entre apps.
const root = resolve(fileURLToPath(import.meta.url), "../../../..");
config({ path: resolve(root, ".env") });

/**
 * ¿Corremos en macOS? Varias features son CGEvents u osascript y no existen
 * fuera de ahí. server-os corre en Linux: en vez de fallar al usarlas, se
 * apagan de entrada para que `capabilities` diga la verdad.
 */
export const IS_MAC = platform() === "darwin";

export const env = {
  PORT: Number(process.env.HERMES_PORT || 8642),
  VAULT_PATH: process.env.VAULT_PATH || "",
  CLAWD_PATH: process.env.CLAWD_PATH || "",
  MACHINE_NAME: process.env.MACHINE_NAME || "local",
  HERMES_API_KEY: process.env.HERMES_API_KEY || "",
  // Multi-máquina: dirección con la que OTROS PCs de la red alcanzan a este
  // agente. Sin ella se deriva de la IP LAN real (presence.ts) — se pone a
  // mano solo si hay un nombre/puerto de por medio (Tailscale, reverse proxy).
  PUBLIC_URL: (process.env.HERMES_PUBLIC_URL || "").replace(/\/$/, ""),
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
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  // Agente de voz de ElevenLabs. Comparte el valor con el dashboard web
  // (NEXT_PUBLIC_…) para que la app móvil obtenga el token del mismo agente.
  ELEVENLABS_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || "",
  // Tutor de inglés (segundo agente; token vía GET /elevenlabs/token?agent=tutor).
  ELEVENLABS_TUTOR_AGENT_ID: process.env.NEXT_PUBLIC_ELEVENLABS_TUTOR_AGENT_ID || "",
  // Proveedor de STT preferido para reuniones: "whisper" | "scribe".
  // Default: scribe primero, Whisper de fallback. Ponlo en "whisper" si
  // ElevenLabs se queda sin créditos para no gastar la llamada fallida a Scribe.
  STT_PROVIDER: (process.env.HERMES_STT || "").toLowerCase(),
  // Junta EN VIVO: STT streaming con diarización (AssemblyAI Universal-Streaming).
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "",
  // Provider del STT en vivo: "assemblyai" | "fake" (guion de prueba, sin gastar).
  LIVE_STT_PROVIDER: (process.env.HERMES_LIVE_STT || "assemblyai").toLowerCase(),
  // Capa RÁPIDA del copiloto de juntas (sugerencias streaming tras una pregunta).
  // Corre con la suscripción de Claude Code (sesión persistente del Agent SDK),
  // no requiere API key. "" = activada | "fake" (respuesta enlatada, e2e sin
  // gastar) | "off" (solo queda el loop estratégico de 20-45 s).
  COPILOT_PROVIDER: (process.env.HERMES_COPILOT || "").toLowerCase(),
  COPILOT_MODEL: process.env.HERMES_COPILOT_MODEL || "claude-haiku-4-5",
  // OAuth de Google, COMPARTIDO: YouTube Analytics de Estudio y (si algún día
  // vuelve) escritura de Calendar. Un solo consentimiento (`pnpm google:auth`)
  // cubre ambos scopes — por eso vive aparte de cualquier feature concreta.
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  GOOGLE_OAUTH_REFRESH_TOKEN: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "",
  // Puerto del loopback para el consentimiento OAuth una sola vez (debe
  // coincidir con el redirect URI autorizado en el cliente OAuth de Google).
  GOOGLE_OAUTH_PORT: Number(process.env.GOOGLE_OAUTH_PORT || 8788),
  // Navegación profunda por voz (chrome-devtools-mcp sobre un Chrome CDP
  // dedicado). "off" no registra el MCP ni expone /browser/navigate.
  // También mac-only: ensureCdpChrome() lanza Chrome con `open -a`.
  BROWSER_AGENT_ENABLED:
    IS_MAC && (process.env.HERMES_BROWSER_AGENT || "").toLowerCase() !== "off",
  // Linear (manejo de tareas). Personal API key (Settings → API en Linear).
  // Sin key, las tools de Linear responden con el CTA de configuración.
  LINEAR_API_KEY: process.env.LINEAR_API_KEY || "",
  // Team por defecto para issues nuevos (key tipo "RUL"). Sin él, el primer team.
  LINEAR_TEAM_KEY: process.env.LINEAR_TEAM_KEY || "",
  // Edición automática de piezas del Estudio: repo local de OpenMontage
  // (agent-first — su CLAUDE.md/AGENT_GUIDE dirigen el pipeline). Si la ruta
  // no existe, el botón de la UI lo dice y las rutas responden 503.
  VIDEO_EDIT_PATH: process.env.VIDEO_EDIT_PATH || resolve(homedir(), "dev/video-edit"),
  // Carpeta madre del material del Estudio (p.ej. un disco extraíble): cada
  // pieza vive en <root>/<slug>/{crudos,assets,exports}. Vacío = sin disco
  // configurado; si no está montado, la UI lo dice y el checklist queda en
  // modo solo-nombres (fallback local en ~/Movies/estudio).
  ESTUDIO_MEDIA_ROOT: process.env.ESTUDIO_MEDIA_ROOT || "",
  // Grafo de código (graphify). launchd corre con PATH mínimo (sin ~/.local/bin),
  // por eso el binario se resuelve por ruta absoluta.
  GRAPHIFY_BIN: process.env.GRAPHIFY_BIN || resolve(homedir(), ".local/bin/graphify"),
  // Repo indexado que responde query_code_graph (piloto: este monorepo).
  CODE_GRAPH_ROOT: process.env.CODE_GRAPH_ROOT || root,
};

export const REPO_ROOT = root;
