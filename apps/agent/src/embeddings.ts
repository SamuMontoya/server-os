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

/** Progreso de un `embedBatch` en curso: cuántos de los `total` textos ya
 *  volvieron (con vector o null), no solo los que faltan mandar. Pensado para
 *  que quien encoló el trabajo (`chat-document-jobs.ts`) pueda mostrar
 *  "4/12 fragmentos" en vez de un spinner mudo — ver auditoría 2026-09-17. */
export type EmbedProgress = (done: number, total: number) => void;

/**
 * Vectoriza varios textos. Devuelve un array paralelo al input; null en las
 * posiciones que fallaron. Un lote fallido no tumba los demás.
 *
 * `onProgress`, si viene, se llama al menos una vez al arrancar (0, total) y
 * una vez por lote interno que vuelve — quien no lo necesita (memorias,
 * vault, etc.) simplemente no lo pasa.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: EmbedProgress,
): Promise<(number[] | null)[]> {
  if (PROVIDER === "none" || texts.length === 0) return texts.map(() => null);
  onProgress?.(0, texts.length);
  return PROVIDER === "ollama" ? viaOllama(texts, onProgress) : viaOpenAI(texts, onProgress);
}

// ── OpenAI ────────────────────────────────────────────────────────────
async function viaOpenAI(texts: string[], onProgress?: EmbedProgress): Promise<(number[] | null)[]> {
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
      });
      if (!res.ok) {
        console.error("[hermes] embeddings openai", res.status, await res.text());
        out.push(...chunk.map(() => null));
        onProgress?.(out.length, texts.length);
        continue;
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const byIndex = new Map(json.data.map((d) => [d.index, d.embedding]));
      chunk.forEach((_, j) => out.push(byIndex.get(j) ?? null));
    } catch (err) {
      console.error("[hermes] embeddings openai fetch", err);
      out.push(...chunk.map(() => null));
    }
    onProgress?.(out.length, texts.length);
  }
  return out;
}

// ── Ollama (local) ────────────────────────────────────────────────────
// /api/embed acepta un array, pero en una máquina chica un lote grande se come
// la RAM: se manda de a pocos y en serie. Vectorizar es barato comparado con
// generar, así que la lentitud no se nota en el uso normal — EXCEPTO en esta
// máquina, que corre con 1 vCPU: medido en caliente, un solo chunk de 6000
// chars tarda ~7.4s (nomic-embed-text, sin GPU) y no es lineal con el
// tamaño (2900 chars → 2.9s, no 3.7s). Un DOCX de 8 chunks = ~60s reales,
// no un cuelgue. Como el vector solo necesita el GIST semántico del texto
// (no cada palabra), se manda un recorte de 4000 chars en vez del chunk
// completo — el `content` guardado en la fila sigue siendo el fragmento
// entero de 6000, esto solo acorta lo que ve el modelo de embeddings.
const OLLAMA_EMBED_INPUT_CAP = 4000;

/**
 * ms/chunk medido en caliente (EMA, arranca en el valor documentado arriba y
 * se recalibra solo con cada request real). Lo lee `chat-document-jobs.ts`
 * para el ETA — leerlo desde afuera es intencional, no un detalle interno:
 * es la única fuente de verdad de "qué tan rápido responde Ollama AHORA" sin
 * necesidad de que cada llamador mida por su cuenta.
 */
export let avgOllamaChunkMs = 7400;
function recordOllamaTiming(elapsedMs: number, itemCount: number): void {
  if (itemCount <= 0) return;
  const perItem = elapsedMs / itemCount;
  // EMA 70/30: no se deja arrastrar por un outlier puntual (una request lenta
  // por una racha de swap no debe disparar el ETA de las siguientes 10).
  avgOllamaChunkMs = avgOllamaChunkMs * 0.7 + perItem * 0.3;
}

/**
 * Mutex de proceso: serializa TODAS las llamadas reales a Ollama, vengan del
 * job que vengan. `-np 1` en el servidor (ver `ps aux`, un solo slot de
 * cómputo) significa que dos requests "en paralelo" desde jobs distintos
 * (INGEST_CONCURRENCY=2) no se paralelizan de verdad — solo compiten por el
 * mismo slot, i/o de red se solapa pero el cómputo no. Sin este mutex cada
 * job mide su propio ms/chunk como si tuviera el slot para él solo, y el ETA
 * de ambos miente (auditoría 2026-09-17). Con el mutex, el segundo job en
 * llegar simplemente espera su turno — mismo trabajo total, pero medido y
 * mostrado con precisión.
 */
let ollamaLock: Promise<void> = Promise.resolve();
function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const runAfter = ollamaLock.then(fn, fn);
  // El lock en sí NUNCA debe quedar rechazado (si no, el próximo `.then(fn)`
  // se saltearía por completo y el mutex se rompe para siempre) — lo que le
  // pasó a `fn` se lo devolvemos igual a quien llamó, vía `runAfter`.
  ollamaLock = runAfter.then(
    () => undefined,
    () => undefined,
  );
  return runAfter;
}

/** Timeout por request: si Ollama queda "vivo pero mudo" (proceso up, sin
 *  responder — pasa con swap/OOM en 1 vCPU), sin esto el job queda colgado
 *  para siempre (ni "ready" ni "error", el chip nunca sale de "processing").
 *  20s de piso + 15s por texto del lote: generoso sobre los ~7.4s/chunk
 *  medidos, para no disparar en falso en una racha normal de lentitud. */
function ollamaTimeoutMs(itemCount: number): number {
  return 20_000 + itemCount * 15_000;
}

/**
 * Un solo hipo (swap momentáneo, el mutex sosteniendo el turno más de la
 * cuenta, un timeout que dispara por poco) no puede reprobar el DOCUMENTO
 * ENTERO — `ingestOne` (chat-documents.ts) descarta el archivo completo si
 * `vectors.some(v => v === null)`, así que un solo lote fallido tira todo a
 * "rojo" sin razón real (auditoría 2026-09-19, reporte de Jaime: "los
 * archivos tardan mucho y luego queda en rojo"). Un reintento único, con su
 * propio timeout completo, cubre el caso transitorio sin ocultar un fallo
 * de verdad (Ollama caído de raíz sigue fallando tras el reintento).
 */
const MAX_OLLAMA_ATTEMPTS = 2;

async function fetchOllamaBatch(chunk: string[], attempt = 1): Promise<(number[] | null)[]> {
  const controller = new AbortController();
  const timeoutMs = ollamaTimeoutMs(chunk.length);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const retryOrGiveUp = (): Promise<(number[] | null)[]> | (number[] | null)[] =>
    attempt < MAX_OLLAMA_ATTEMPTS ? fetchOllamaBatch(chunk, attempt + 1) : chunk.map(() => null);
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.OLLAMA_EMBED_MODEL, input: chunk }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[hermes] embeddings ollama (intento ${attempt}/${MAX_OLLAMA_ATTEMPTS})`,
        res.status,
        await res.text(),
      );
      return retryOrGiveUp();
    }
    const json = (await res.json()) as { embeddings?: number[][] };
    const vecs = json.embeddings ?? [];
    recordOllamaTiming(Date.now() - startedAt, chunk.length);
    // Si el modelo devuelve otra dimensión, insertarlo reventaría el insert
    // con un error de pgvector difícil de leer: mejor descartarlo aquí.
    return chunk.map((_, j) => {
      const v = vecs[j];
      if (v && v.length === EMB.dims) return v;
      if (v) console.error(`[hermes] embeddings ollama: ${v.length} dims, esperaba ${EMB.dims}`);
      return null;
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.error(
        `[hermes] embeddings ollama: sin respuesta tras ${timeoutMs}ms ` +
          `(intento ${attempt}/${MAX_OLLAMA_ATTEMPTS})`,
      );
    } else {
      console.error(`[hermes] embeddings ollama fetch (intento ${attempt}/${MAX_OLLAMA_ATTEMPTS})`, err);
    }
    return retryOrGiveUp();
  } finally {
    clearTimeout(timer);
  }
}

async function viaOllama(texts: string[], onProgress?: EmbedProgress): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map((t) => (t || " ").slice(0, OLLAMA_EMBED_INPUT_CAP));
    const vecs = await withOllamaLock(() => fetchOllamaBatch(chunk));
    out.push(...vecs);
    onProgress?.(out.length, texts.length);
  }
  return out;
}
