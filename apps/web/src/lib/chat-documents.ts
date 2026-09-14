/**
 * Documentos subidos a mano en el composer (el clip junto al micrófono).
 *
 * A diferencia de las imágenes (sube-y-guarda-el-id, ver chat-attachments.ts),
 * acá no hay id que guardar: el archivo se procesa y se descarta del lado del
 * servidor en el mismo request — la subida YA es el procesamiento completo
 * (extraer texto, trocear, vectorizar, guardar en chat_docs). Lo que vuelve
 * es un resumen, no una referencia a nada persistente.
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

export interface IngestedDocSummary {
  name: string;
  docId: string;
  chunks: number;
  chars: number;
  truncated: boolean;
}

export interface IngestFailureSummary {
  name: string;
  error: string;
}

export interface UploadDocumentsResult {
  ok: IngestedDocSummary[];
  failed: IngestFailureSummary[];
}

export async function uploadChatDocuments(files: File[]): Promise<UploadDocumentsResult> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await hermesFetch("/chat/documents", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as UploadDocumentsResult & { error?: string };
  if (!res.ok) throw new Error(data.error || `no se pudieron procesar los documentos (${res.status})`);
  return { ok: data.ok ?? [], failed: data.failed ?? [] };
}
