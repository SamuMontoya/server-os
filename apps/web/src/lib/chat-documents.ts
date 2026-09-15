/**
 * Documentos subidos a mano en el composer (el clip junto al micrófono).
 *
 * Desde 2026-09-15 la subida es ASÍNCRONA (auditoría: un PDF de 2MB tardaba
 * ~2-3 min de Ollama serial en el vCPU único del servidor, y ese tiempo
 * entero bloqueaba el fetch). `POST /chat/documents` ahora responde YA con
 * el docId en "processing" — el archivo se procesa y se descarta del lado
 * del servidor en BACKGROUND (extraer texto, trocear, vectorizar, guardar en
 * chat_docs), y el composer hace polling a `GET /chat/documents/status`
 * hasta ver "ready" o "error" (ver `fetchChatDocumentStatus`, usado en
 * laboratorio/page.tsx).
 */
import { hermesFetch } from "@/lib/hermes";

/** Debe coincidir con SUPPORTED_LABEL en apps/agent/src/documents/chat-documents.ts. */
const ACCEPTED_EXT = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".epub",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  ".svg",
  // Imágenes: el clip las trata como documento (OCR + indexado), a
  // diferencia de pegar/soltar donde van a addImages (visión directa) —
  // ver el reparto por tipo en addFiles, en laboratorio/page.tsx.
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tiff",
  ".gif",
];

export function isSupportedDocument(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXT.some((ext) => name.endsWith(ext));
}

/** Lo que devuelve el POST apenas acepta el archivo, antes de vectorizarlo. */
export interface QueuedChatDocument {
  name: string;
  docId: string;
  status: "processing";
}

/** Estado de un documento en curso o terminado, tal como lo reporta `/status`. */
export interface ChatDocumentJobStatus {
  docId: string;
  status: "processing" | "ready" | "error" | "not_found";
  name?: string;
  chunks?: number;
  chars?: number;
  truncated?: boolean;
  error?: string;
}

/**
 * Sube UN archivo y devuelve de inmediato con su docId en "processing": el
 * vectorizado sigue en el servidor, sin bloquear este fetch (antes tardaba
 * lo mismo que tarda Ollama en vectorizar el documento entero — hasta varios
 * minutos con un PDF grande). Quien llama debe hacer polling con
 * `fetchChatDocumentStatus` para saber cuándo queda listo.
 */
export async function startChatDocumentUpload(file: File): Promise<QueuedChatDocument> {
  const form = new FormData();
  form.append("files", file, file.name);
  const res = await hermesFetch("/chat/documents", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as {
    processing?: QueuedChatDocument[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `no se pudo subir el documento (${res.status})`);
  const queued = data.processing?.[0];
  if (!queued) throw new Error("el servidor no confirmó la subida");
  return queued;
}

/**
 * Estado de una tanda de documentos por docId — el polling que reemplaza la
 * espera bloqueante de antes. Ids que el servidor no reconoce (evictados tras
 * 30 min sin consultarlos, o inválidos) vuelven con `status: "not_found"` en
 * vez de romper la respuesta entera.
 */
export async function fetchChatDocumentStatus(ids: string[]): Promise<ChatDocumentJobStatus[]> {
  if (ids.length === 0) return [];
  const qs = ids.map(encodeURIComponent).join(",");
  const res = await hermesFetch(`/chat/documents/status?ids=${qs}`);
  const data = (await res.json().catch(() => ({}))) as { jobs?: ChatDocumentJobStatus[]; error?: string };
  if (!res.ok) throw new Error(data.error || `no se pudo consultar el estado (${res.status})`);
  return data.jobs ?? [];
}
