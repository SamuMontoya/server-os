/**
 * Documentos subidos al chat como JOBS DEL SERVIDOR, no como cuerpo del
 * request — mismo patrón que `agent/chat-turns.ts` para los turnos.
 *
 * El problema que resolvía `ingestUploadedDocuments` corriendo dentro de
 * `POST /chat/documents`: extraer + trocear + vectorizar un PDF de 2MB tarda
 * ~2-3 minutos en este VPS de 1 vCPU (Ollama sin GPU, serial). El request
 * HTTP se quedaba abierto todo ese tiempo, el composer mostraba "subiendo"
 * sin ningún avance real, y el usuario no podía mandar el mensaje ni subir
 * más archivos mientras tanto (auditoría 2026-09-15).
 *
 * Acá el documento se registra YA (estado "processing") y `startChatDocumentJobs`
 * DEVUELVE de inmediato con sus docId — el trabajo pesado sigue en este mismo
 * proceso Node, sin bloquear el request. El cliente hace polling a
 * `GET /chat/documents/status?ids=...` hasta ver "ready" o "error".
 *
 * Memoria pura, igual que `jobs.ts` y `chat-turns.ts`: se resetea con cada
 * reinicio del proceso. Un documento que estaba "processing" cuando el
 * servidor reinicia queda huérfano — el cliente nunca ve pasar de
 * "processing" y debe reintentar. A diferencia de los turnos de chat (que sí
 * checkpointean para sobrevivir un reinicio), acá no hace falta: perder una
 * subida cuesta segundos de red para volver a mandar el archivo, no minutos
 * de conversación con el modelo.
 */
import { randomUUID } from "node:crypto";
import { extractText } from "../drive/extract.js";
import { hasSupabase } from "../supabase.js";
import { embedBatch } from "../embeddings.js";
import {
  ingestOne,
  defaultInsertRows,
  INGEST_CONCURRENCY,
  type UploadedFile,
  type IngestDeps,
} from "./chat-documents.js";

export type DocJobStatus = "processing" | "ready" | "error";

export interface DocJob {
  docId: string;
  name: string;
  status: DocJobStatus;
  chunks?: number;
  chars?: number;
  truncated?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface QueuedDoc {
  docId: string;
  name: string;
  status: "processing";
}

/** Jobs vivos en memoria, por docId. */
const jobs = new Map<string, DocJob>();

/** Documentos retenidos en memoria (los viejos ya están en Supabase o descartados). */
const MAX_JOBS = 300;
/** Un job terminado se retiene esto para quien haga polling tarde. */
const RETAIN_MS = 30 * 60 * 1000;

/** Suelta jobs viejos: memoria acotada sin tocar los que siguen "processing". */
function evict(): void {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, j] of jobs) {
    if (j.status !== "processing" && (j.endedAt ?? j.startedAt) < cutoff) jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()]
    .filter((j) => j.status !== "processing")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.docId);
}

/**
 * Encola los archivos y DEVUELVE de una con sus docId en "processing": el
 * trabajo (extraer/trocear/vectorizar/guardar) sigue en background con
 * concurrencia acotada (`INGEST_CONCURRENCY`, igual que la versión síncrona)
 * — en 1 vCPU más concurrencia no vectoriza más rápido, solo compite por el
 * mismo core; la ganancia real es que la extracción del siguiente archivo se
 * solapa con la espera de red del embedding del anterior.
 */
export function startChatDocumentJobs(
  files: UploadedFile[],
  deps: Partial<IngestDeps> = {},
): QueuedDoc[] {
  evict();
  const extract = deps.extractText ?? extractText;
  const embed = deps.embedBatch ?? embedBatch;
  const insertRows = deps.insertRows ?? defaultInsertRows;
  const isReady = deps.isReady ?? hasSupabase;

  const queued: QueuedDoc[] = files.map((f) => {
    const docId = randomUUID();
    jobs.set(docId, { docId, name: f.name, status: "processing", startedAt: Date.now() });
    return { docId, name: f.name, status: "processing" as const };
  });

  if (!isReady()) {
    for (const q of queued) {
      const j = jobs.get(q.docId);
      if (!j) continue;
      j.status = "error";
      j.error = "Supabase no configurado";
      j.endedAt = Date.now();
    }
    return queued;
  }

  // Mismo patrón cursor/workers que `ingestUploadedDocuments`: concurrencia
  // acotada, no `Promise.all` desatado.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const file = files[i];
      if (!file) return;
      const docId = queued[i].docId;
      const result = await ingestOne(
        file,
        { extractText: extract, embedBatch: embed, insertRows },
        docId,
      );
      const j = jobs.get(docId);
      if (!j) continue; // Se evictó (poco probable en 30 min, pero no revienta si pasa).
      if ("ok" in result) {
        j.status = "ready";
        j.chunks = result.ok.chunks;
        j.chars = result.ok.chars;
        j.truncated = result.ok.truncated;
      } else {
        j.status = "error";
        j.error = result.failed.error;
      }
      j.endedAt = Date.now();
    }
  };
  const workers = Array.from({ length: Math.min(INGEST_CONCURRENCY, files.length) }, worker);
  // Sin await: el llamador (la ruta HTTP) ya devolvió la respuesta 202 con
  // `queued` — este trabajo vive del proceso en adelante, no del request.
  void Promise.all(workers);

  return queued;
}

/** Estado de una tanda de ids, para el polling del composer. Ids desconocidos
 *  (nunca existieron o ya se evictaron) vuelven como "not_found" en vez de
 *  romper la respuesta entera. */
export function getDocJobs(ids: string[]): (DocJob | { docId: string; status: "not_found" })[] {
  return ids.map((id) => jobs.get(id) ?? { docId: id, status: "not_found" as const });
}

/** Solo para tests: vacía el registro entre casos. */
export function _resetDocJobsForTests(): void {
  jobs.clear();
}
