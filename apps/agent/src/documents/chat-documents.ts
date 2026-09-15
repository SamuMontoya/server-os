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
/**
 * Tope de archivos por REQUEST HTTP (sanidad del body, no la experiencia de
 * subida): el composer (ver laboratorio/page.tsx, `addDocuments`) ya no
 * manda una tanda entera en un solo POST — sube cada archivo por su cuenta
 * (progresivo, con concurrencia acotada), así que en la práctica esto casi
 * siempre es 1. Se deja alto por si algo más llama al endpoint con varios a
 * la vez; antes era 5 y ESE era el techo que Samu pedía quitar (2026-09-15:
 * "que deje cargar los documentos que se quiera").
 */
export const MAX_DOCUMENTS_PER_UPLOAD = 40;
/**
 * Tope de FRAGMENTOS **por documento** (antes era un presupuesto COMPARTIDO
 * entre todos los archivos de una misma subida — penalizaba subir varios
 * juntos sin motivo real. Ahora que cada archivo casi siempre viaja en su
 * propio request, el límite natural es por archivo). Un PDF de 80 páginas
 * cabe de sobra; uno de cientos de páginas se recorta y se avisa como
 * "truncado", nunca se pierde en silencio.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 60;
/**
 * Cuántos archivos se procesan EN PARALELO cuando llegan varios en la MISMA
 * subida (llamada directa al endpoint con `files` de más de 1 elemento). En
 * este hardware (1 vCPU) el cómputo de Ollama es serial de todos modos — la
 * ganancia real es que la EXTRACCIÓN (parseo de PDF/DOCX, OCR) del siguiente
 * archivo se solapa con la espera de red del embedding del anterior, en vez
 * de quedar 100% en fila. 2 y no más: con 1 vCPU, más concurrencia solo
 * compite por el mismo core sin ganar nada.
 */
export const INGEST_CONCURRENCY = 2;

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

export const defaultInsertRows = async (rows: ChatDocRow[]): Promise<string | null> => {
  if (!supabase) return "Supabase no configurado";
  const { error } = await supabase.from("chat_docs").insert(rows);
  return error ? error.message : null;
};

/**
 * Procesa UN archivo de punta a punta: extraer → trocear → vectorizar →
 * guardar. Separado de `ingestUploadedDocuments` para poder correr varios
 * en paralelo (ver `INGEST_CONCURRENCY`) sin duplicar la lógica.
 *
 * Exportada (antes privada) porque `chat-document-jobs.ts` la reusa para el
 * pipeline asíncrono: el docId ahora lo decide el LLAMADOR (no se genera acá
 * adentro) para poder registrar el job ANTES de que arranque el trabajo
 * pesado — el cliente necesita el id ya en la respuesta 202, no al final.
 */
export async function ingestOne(
  file: UploadedFile,
  deps: Required<Pick<IngestDeps, "extractText" | "embedBatch" | "insertRows">>,
  docId: string = randomUUID(),
): Promise<{ ok: IngestedDoc } | { failed: IngestFailure }> {
  let text: string;
  try {
    text = await deps.extractText(file.buffer, file.mimeType, file.name);
  } catch (err) {
    return { failed: { name: file.name, error: (err as Error).message } };
  }
  const content = sanitizeExtractedText(text).trim();
  if (!content) {
    return {
      failed: { name: file.name, error: `sin texto extraíble (¿formato soportado? ${SUPPORTED_LABEL})` },
    };
  }

  let pieces = chunkText(content);
  const truncated = pieces.length > MAX_CHUNKS_PER_DOCUMENT;
  if (truncated) pieces = pieces.slice(0, MAX_CHUNKS_PER_DOCUMENT);
  if (pieces.length === 0) {
    return { failed: { name: file.name, error: "no se generó ningún fragmento del texto extraído" } };
  }

  const vectors = await deps.embedBatch(pieces.map((p) => `${file.name}\n${p}`));
  // embedBatch nunca lanza: si el motor de embeddings falla (Ollama caído,
  // OpenAI sin key, rate limit, etc.) devuelve `null` por posición en vez de
  // tumbar el batch entero (ver embeddings.ts). Si NO se chequea acá, esa
  // fila se inserta con embedding null — pasa como "ok" en la respuesta
  // pero `match_knowledge` la filtra con `where embedding is not null`, así
  // que queda indexada en apariencia y en realidad es invisible para
  // search_knowledge. Mejor fallar el archivo entero y que el usuario
  // reintente, que mentir "ya es buscable".
  if (vectors.length !== pieces.length || vectors.some((v) => v === null)) {
    return {
      failed: {
        name: file.name,
        error: "no se pudo vectorizar (motor de embeddings no disponible); reintenta la subida",
      },
    };
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

  const insertError = await deps.insertRows(rows);
  if (insertError) {
    return { failed: { name: file.name, error: `no se pudo guardar: ${insertError}` } };
  }

  return { ok: { name: file.name, docId, chunks: pieces.length, chars: content.length, truncated } };
}

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

  // Concurrencia acotada, no `Promise.all` desatado: en 1 vCPU (esta
  // máquina) no hay CPU de sobra que repartir, pero SÍ hay tiempo muerto de
  // red mientras se espera la respuesta de Ollama/Supabase — es ahí donde
  // el archivo siguiente gana adelantando su extracción. Con más de
  // `INGEST_CONCURRENCY` en vuelo no se gana nada, solo se compite por el
  // mismo core.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(INGEST_CONCURRENCY, files.length) }, async () => {
    for (;;) {
      const i = cursor++;
      const file = files[i];
      if (!file) return;
      const result = await ingestOne(file, { extractText: extract, embedBatch: embed, insertRows });
      if ("ok" in result) ok.push(result.ok);
      else failed.push(result.failed);
    }
  });
  await Promise.all(workers);

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
