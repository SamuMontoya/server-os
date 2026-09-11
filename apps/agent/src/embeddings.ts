import { env } from "./env.js";

/**
 * Embeddings con proveedor intercambiable.
 *
 * El resto del agente solo llama a `embed()` / `embedBatch()` y lee las
 * constantes `EMB.col` / `EMB.rpc` — nunca sabe qué motor hay debajo. Cambiar
 * de proveedor es una variable de entorno, no cirugía en 7 archivos.
 *
 *   openai → text-embedding-3-small, 1536 dims, columnas `embedding`
 *   ollama → modelo local (nomic-embed-text, 768), columnas `embedding_local`
 *            y RPCs `*_local` (migración 025)
 *   none   → sin vectores; la búsqueda cae a recencia/ILIKE
 *
 * Las dos familias de columnas conviven en la MISMA base. pgvector no compara
 * dimensiones distintas, así que cada proveedor ve solo su propio índice: lo
 * que escribe el servidor con ollama no lo encuentra la Mac con openai. Es el
 * precio de no convertir el esquema y de que ninguna de las dos se rompa.
 */

export type EmbeddingProvider = "openai" | "ollama" | "none";

/**
 * Techo por request de embeddings. Sin esto, un Ollama colgado (modelo
 * descargándose, proceso caído pero el puerto sigue "abierto", CPU saturada)
 * bloqueaba `searchKnowledge()` SIN LÍMITE — y esto se llama en CADA turno de
 * chat, antes de la primera palabra (ver buildTurnContext en
 * agent/system-prompt.ts). El try/catch de abajo ya trata cualquier fallo de
 * red como "sin embedding" y sigue con el fallback por texto: agregar el
 * timeout no cambia el manejo de errores, solo le pone un techo.
 */
const OLLAMA_TIMEOUT_MS = 5000;
const OPENAI_TIMEOUT_MS = 6000;

function resolveProvider(): EmbeddingProvider {
  const p = env.EMBEDDINGS_PROVIDER;
  if (p === "ollama" || p === "openai" || p === "none") return p;
  // Sin declarar: openai si hay key (comportamiento histórico), si no nada.
  return env.OPENAI_API_KEY ? "openai" : "none";
}

export const PROVIDER: EmbeddingProvider = resolveProvider();

/** Sufijo de las columnas/RPC según el proveedor. Vacío = esquema original. */
const SUF = PROVIDER === "ollama" ? "_local" : "";

/**
 * Nombres de columna y RPC que debe usar este proceso. Los consumidores los
 * leen de aquí en vez de escribir el string a mano.
 */
export const EMB = {
  provider: PROVIDER,
  dims: PROVIDER === "ollama" ? 768 : 1536,
  /** Columna de vector en memories / task_executions / conversation_messages / vault_docs. */
  col: `embedding${SUF}`,
  /** Columna de vector del resumen en meetings. */
  meetingCol: `summary_embedding${SUF}`,
  rpc: {
    memories: `match_memories${SUF}`,
    knowledge: `match_knowledge${SUF}`,
    meetings: `match_meetings${SUF}`,
  },
} as const;

/** ¿Hay motor de embeddings? Si no, quien llama debe caer a búsqueda por texto. */
export function embeddingsEnabled(): boolean {
  return PROVIDER !== "none";
}

export async function embed(text: string): Promise<number[] | null> {
  const [vector] = await embedBatch([text]);
  return vector ?? null;
}

/**
 * Vectoriza varios textos. Devuelve un array paralelo al input; null en las
 * posiciones que fallaron. Un lote fallido no tumba los demás.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (PROVIDER === "none" || texts.length === 0) return texts.map(() => null);
  return PROVIDER === "ollama" ? viaOllama(texts) : viaOpenAI(texts);
}

// ── OpenAI ────────────────────────────────────────────────────────────
async function viaOpenAI(texts: string[]): Promise<(number[] | null)[]> {
  if (!env.OPENAI_API_KEY) return texts.map(() => null);
  const out: (number[] | null)[] = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    // La API rechaza strings vacíos dentro de un array: un espacio los salva.
    const chunk = texts.slice(i, i + BATCH).map((t) => (t || " ").slice(0, 8000));
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: chunk }),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error("[hermes] embeddings openai", res.status, await res.text());
        out.push(...chunk.map(() => null));
        continue;
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const byIndex = new Map(json.data.map((d) => [d.index, d.embedding]));
      chunk.forEach((_, j) => out.push(byIndex.get(j) ?? null));
    } catch (err) {
      console.error("[hermes] embeddings openai fetch", err);
      out.push(...chunk.map(() => null));
    }
  }
  return out;
}

// ── Ollama (local) ────────────────────────────────────────────────────
// /api/embed acepta un array, pero en una máquina chica un lote grande se come
// la RAM: se manda de a pocos y en serie. Vectorizar es barato comparado con
// generar, así que la lentitud no se nota en el uso normal.
async function viaOllama(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map((t) => (t || " ").slice(0, 8000));
    try {
      const res = await fetch(`${env.OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OLLAMA_EMBED_MODEL, input: chunk }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error("[hermes] embeddings ollama", res.status, await res.text());
        out.push(...chunk.map(() => null));
        continue;
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      const vecs = json.embeddings ?? [];
      // Si el modelo devuelve otra dimensión, insertarlo reventaría el insert
      // con un error de pgvector difícil de leer: mejor descartarlo aquí.
      chunk.forEach((_, j) => {
        const v = vecs[j];
        if (v && v.length === EMB.dims) out.push(v);
        else {
          if (v) console.error(`[hermes] embeddings ollama: ${v.length} dims, esperaba ${EMB.dims}`);
          out.push(null);
        }
      });
    } catch (err) {
      console.error("[hermes] embeddings ollama fetch", err);
      out.push(...chunk.map(() => null));
    }
  }
  return out;
}
