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
 * DOCX/XLSX/PPTX/EPUB/texto plano/imágenes vía OCR) y `embedBatch`/`EMB` de
 * embeddings.ts. Lo único nuevo acá es el chunking (los adjuntos de Drive
 * nunca lo necesitaron porque se truncaban a 16k chars; un PDF de 80 páginas
 * que sube alguien a mano sí puede pasar de eso, y truncar perdería la mayor
 * parte del documento en vez de solo indexarlo en varias filas).
 */
import { randomUUID, createHash } from "node:crypto";
import { extractText } from "../drive/extract.js";
import { sanitizeExtractedText } from "../text-sanitize.js";
import { chunkText } from "./chunk.js";
import { supabase, hasSupabase } from "../supabase.js";
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
const SUPPORTED_LABEL =
  "PDF, DOCX, XLSX, PPTX, EPUB, TXT, MD, CSV, JSON, SVG o imagen (JPG/PNG/WEBP/BMP/TIFF/GIF, vía OCR)";

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

export interface ChatDocRow {
  doc_id: string;
  chunk_index: number;
  chunk_count: number;
  name: string;
  mime_type: string | null;
  content: string;
  content_hash: string;
  [col: string]: unknown;
}

/**
 * Dependencias inyectables, con las reales de producción como default. Igual
 * que `createTurnEngine` en chat-turns.ts: el motor recibe sus efectos de
 * lado en vez de importarlos a fuego, así los tests corren sin red, sin
 * Ollama/OpenAI y sin Supabase de verdad.
 */
export interface IngestDeps {
  extractText: (buf: Buffer, mimeType: string, name: string) => Promise<string>;
  embedBatch: (texts: string[]) => Promise<(number[] | null)[]>;
  /** null = insert OK; string = mensaje de error de Supabase. */
  insertRows: (rows: ChatDocRow[]) => Promise<string | null>;
  /** ¿Hay dónde guardar? Si no, se falla rápido sin gastar extracción/embeddings. */
  isReady: () => boolean;
}

const defaultInsertRows = async (rows: ChatDocRow[]): Promise<string | null> => {
  if (!supabase) return "Supabase no configurado";
  const { error } = await supabase.from("chat_docs").insert(rows);
  return error ? error.message : null;
};

export async function ingestUploadedDocuments(
  files: UploadedFile[],
  deps: Partial<IngestDeps> = {},
): Promise<IngestResult> {
  const extract = deps.extractText ?? extractText;
  const embed = deps.embedBatch ?? embedBatch;
  const insertRows = deps.insertRows ?? defaultInsertRows;
  const isReady = deps.isReady ?? hasSupabase;

  const ok: IngestedDoc[] = [];
  const failed: IngestFailure[] = [];

  if (!isReady()) {
    for (const f of files) failed.push({ name: f.name, error: "Supabase no configurado" });
    return { ok, failed };
  }

  let chunkBudget = MAX_TOTAL_CHUNKS_PER_UPLOAD;

  for (const file of files) {
    let text: string;
    try {
      text = await extract(file.buffer, file.mimeType, file.name);
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
    const vectors = await embed(pieces.map((p) => `${file.name}\n${p}`));
    // embedBatch nunca lanza: si el motor de embeddings falla (Ollama caído,
    // OpenAI sin key, rate limit, etc.) devuelve `null` por posición en vez de
    // tumbar el batch entero (ver embeddings.ts). Si NO se chequea acá, esa
    // fila se inserta con embedding null — pasa como "ok" en la respuesta
    // pero `match_knowledge` la filtra con `where embedding is not null`, así
    // que queda indexada en apariencia y en realidad es invisible para
    // search_knowledge. Mejor fallar el archivo entero y que el usuario
    // reintente, que mentir "ya es buscable".
    if (vectors.length !== pieces.length || vectors.some((v) => v === null)) {
      failed.push({
        name: file.name,
        error: "no se pudo vectorizar (motor de embeddings no disponible); reintenta la subida",
      });
      continue;
    }
    const rows: ChatDocRow[] = pieces.map((p, i) => ({
      doc_id: docId,
      chunk_index: i,
      chunk_count: pieces.length,
      name: file.name,
      mime_type: file.mimeType || null,
      content: p,
      content_hash: createHash("sha1").update(p).digest("hex"),
      [EMB.col]: vectors[i],
    }));

    const insertError = await insertRows(rows);
    if (insertError) {
      failed.push({ name: file.name, error: `no se pudo guardar: ${insertError}` });
      continue;
    }

    ok.push({ name: file.name, docId, chunks: pieces.length, chars: content.length, truncated });
  }

  return { ok, failed };
}

// ── Lectura fiel del documento completo (no por similitud) ─────────────
//
// search_knowledge/match_knowledge trae como mucho unos pocos fragmentos por
// SIMILITUD SEMÁNTICA a una query — perfecto para "¿qué dice sobre X?", pero
// inservible para "dame el documento completo": con un doc de más de un
// puñado de chunks, siempre devuelve los mismos 1-2 fragmentos (los más
// parecidos a lo último preguntado) y nunca el resto. Estas dos funciones
// leen chat_docs directo, por doc_id, TODOS los fragmentos en orden — para
// reconstruir un documento fielmente (una matriz de auditoría entera, por
// ejemplo) hace falta esto, no una búsqueda.

export interface FullChatDocument {
  docId: string;
  name: string;
  chunkCount: number;
  content: string;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Texto completo de un documento subido al chat: concatena TODOS sus
 * fragmentos en orden de chunk_index. Acepta un doc_id exacto o un nombre
 * (o parte de él, ILIKE) — con nombre, resuelve al más reciente que matchee.
 * El overlap de ~300 chars entre fragmentos consecutivos (ver chunk.ts)
 * queda duplicado en el join: se prefiere ese pequeño ruido a arriesgar
 * cortar mal el texto tratando de deduplicarlo.
 */
export async function getFullChatDocument(nameOrDocId: string): Promise<FullChatDocument | null> {
  if (!supabase) return null;

  let docId = nameOrDocId;
  if (!UUID_RE.test(nameOrDocId)) {
    const { data: match, error } = await supabase
      .from("chat_docs")
      .select("doc_id, created_at")
      .ilike("name", `%${nameOrDocId}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !match?.length) return null;
    docId = match[0].doc_id as string;
  }

  const { data: rows, error } = await supabase
    .from("chat_docs")
    .select("chunk_index, chunk_count, name, content, created_at")
    .eq("doc_id", docId)
    .order("chunk_index", { ascending: true });
  if (error || !rows?.length) return null;

  return {
    docId,
    name: rows[0].name as string,
    chunkCount: rows[0].chunk_count as number,
    content: rows.map((r) => r.content as string).join("\n"),
    createdAt: rows[0].created_at as string,
  };
}

/** Documentos subidos al chat, uno por doc_id (su primer fragmento), más recientes primero. */
export async function listChatDocuments(
  limit = 20,
): Promise<{ docId: string; name: string; chunkCount: number; createdAt: string }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("chat_docs")
    .select("doc_id, name, chunk_count, created_at")
    .eq("chunk_index", 0)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => ({
    docId: r.doc_id as string,
    name: r.name as string,
    chunkCount: r.chunk_count as number,
    createdAt: r.created_at as string,
  }));
}
