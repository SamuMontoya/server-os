/**
 * Documentos que Jaime sube a mano en el composer del chat (el clip junto al
 * micrófono) — no vienen de Drive. Se procesan, se trocean, se vectorizan y
 * el archivo original se DESCARTA: no vive en disco en ningún momento, solo
 * el texto extraído (por fragmento) en la tabla `chat_docs`.
 *
 * Automático por defecto: subir el archivo YA lo indexa, sin pedir
 * confirmación — igual que las imágenes se suben solas al pegarlas. Si en el
 * futuro hace falta un "no indexes esto todavía", es un flag nuevo en el
 * endpoint; no existe aún.
 *
 * Reusa exactamente lo que ya construimos para Drive: `extractText()` (PDF/
 * DOCX/XLSX/texto plano) y `embedBatch`/`EMB` de embeddings.ts. Lo único
 * nuevo acá es el chunking (los adjuntos de Drive nunca lo necesitaron
 * porque se truncaban a 16k chars; un PDF de 80 páginas que sube alguien a
 * mano sí puede pasar de eso, y truncar perdería la mayor parte del
 * documento en vez de solo indexarlo en varias filas).
 */
import { randomUUID, createHash } from "node:crypto";
import { extractText } from "../drive/extract.js";
import { sanitizeExtractedText } from "../text-sanitize.js";
import { chunkText } from "./chunk.js";
import { supabase } from "../supabase.js";
import { embedBatch, EMB } from "../embeddings.js";

/** Tope por archivo: un PDF grande cabe de sobra; algo mal etiquetado no. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Tope por subida: más de esto y una sola tanda se vuelve cara sin ser más útil. */
export const MAX_DOCUMENTS_PER_UPLOAD = 5;
/**
 * Tope de FRAGMENTOS por subida (no de archivos): 5 PDFs de 80 páginas cada
 * uno serían cientos de llamadas de embedding en un hardware sin GPU. Se
 * reparte proporcional entre los archivos de la tanda y lo que no entra se
 * nota como "truncado", nunca se pierde en silencio.
 */
export const MAX_TOTAL_CHUNKS_PER_UPLOAD = 60;

/** Mismo criterio que drive/extract.ts — aquí solo para el mensaje de error. */
const SUPPORTED_LABEL = "PDF, DOCX, XLSX, TXT, MD, CSV o JSON";

export interface UploadedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface IngestedDoc {
  name: string;
  docId: string;
  chunks: number;
  chars: number;
  truncated: boolean;
}

export interface IngestFailure {
  name: string;
  error: string;
}

export interface IngestResult {
  ok: IngestedDoc[];
  failed: IngestFailure[];
}

export async function ingestUploadedDocuments(files: UploadedFile[]): Promise<IngestResult> {
  const ok: IngestedDoc[] = [];
  const failed: IngestFailure[] = [];

  if (!supabase) {
    for (const f of files) failed.push({ name: f.name, error: "Supabase no configurado" });
    return { ok, failed };
  }

  let chunkBudget = MAX_TOTAL_CHUNKS_PER_UPLOAD;

  for (const file of files) {
    let text: string;
    try {
      text = await extractText(file.buffer, file.mimeType, file.name);
    } catch (err) {
      failed.push({ name: file.name, error: (err as Error).message });
      continue;
    }
    const content = sanitizeExtractedText(text).trim();
    if (!content) {
      failed.push({ name: file.name, error: `sin texto extraíble (¿formato soportado? ${SUPPORTED_LABEL})` });
      continue;
    }

    let pieces = chunkText(content);
    const truncated = pieces.length > chunkBudget;
    if (truncated) pieces = pieces.slice(0, Math.max(0, chunkBudget));
    if (pieces.length === 0) {
      failed.push({ name: file.name, error: "se quedó sin cupo de fragmentos en esta subida (demasiados archivos grandes a la vez)" });
      continue;
    }
    chunkBudget -= pieces.length;

    const docId = randomUUID();
    const vectors = await embedBatch(pieces.map((p) => `${file.name}\n${p}`));
    const rows = pieces.map((p, i) => ({
      doc_id: docId,
      chunk_index: i,
      chunk_count: pieces.length,
      name: file.name,
      mime_type: file.mimeType || null,
      content: p,
      content_hash: createHash("sha1").update(p).digest("hex"),
      [EMB.col]: vectors[i],
    }));

    const { error } = await supabase.from("chat_docs").insert(rows);
    if (error) {
      failed.push({ name: file.name, error: `no se pudo guardar: ${error.message}` });
      continue;
    }

    ok.push({ name: file.name, docId, chunks: pieces.length, chars: content.length, truncated });
  }

  return { ok, failed };
}
