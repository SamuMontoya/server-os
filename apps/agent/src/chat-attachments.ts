/**
 * Imágenes adjuntas al chat: se guardan en disco y al agente le llega la RUTA.
 *
 * La decisión de diseño que gobierna todo el archivo: NO metemos la imagen en
 * base64 dentro del turno. El motor del chat (agent/chat-turns.ts) manda un
 * `prompt: string` al Claude Agent SDK, y ese SDK ya tiene una tool que lee
 * imágenes de verdad — `Read` sobre un .png devuelve la imagen al modelo como
 * bloque visual, no como texto. Así que basta con guardar el archivo y nombrar
 * la ruta en el prompt.
 *
 * Lo que se gana con eso:
 *   - Cero cambios en el transporte: el prompt sigue siendo un string, el
 *     buffer de eventos sigue siendo texto, Supabase sigue guardando TEXT.
 *   - Un pantallazo de 2 MB no viaja como 2.7 MB de base64 dentro del JSON del
 *     turno, ni se duplica en cada reintento del motor (hace hasta 3).
 *   - La imagen SIGUE en disco en los turnos siguientes: "y ahora mira otra vez
 *     el margen de arriba" funciona porque el agente puede re-leer el archivo.
 *
 * Lo que cuesta: el modelo tiene que decidir llamar a `Read`. Por eso el
 * preámbulo que arma `attachmentPreamble()` es una instrucción directa, no una
 * sugerencia — ver agent/session.ts.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { REPO_ROOT } from "./env.js";

/**
 * Formatos que el modelo ve de verdad. La lista es corta a propósito: cada
 * entrada es un tipo que la API de Anthropic acepta como bloque `image`
 * (png/jpeg/webp/gif). Un .heic de iPhone NO entra — se rechaza con mensaje
 * claro en vez de guardarse para fallar después dentro del turno.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** mime → extensión canónica. Lo que llega del clipboard es el mime, no un nombre. */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Tope por imagen. Un pantallazo de 5K cabe de sobra; un vídeo mal etiquetado no. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Tope por turno: más de esto y el turno se vuelve caro sin ser más útil. */
export const MAX_ATTACHMENTS_PER_TURN = 4;
/** Se barren los adjuntos más viejos que esto (el chat no es un archivo). */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

const DIR = join(REPO_ROOT, ".data", "chat-attachments");

/**
 * El id ES el nombre del archivo, así que validarlo como UUID es lo que hace
 * imposible el path traversal: sin barras, sin puntos, sin `..`. Cualquier
 * resolución de ruta pasa por aquí antes de tocar el disco.
 */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatAttachment {
  id: string;
  /** Nombre original (informativo: se muestra en el chip de la UI). */
  name: string;
  mime: string;
  size: number;
  /** Ruta absoluta en disco. Solo para uso del servidor — nunca al cliente. */
  path: string;
}

/** Extensión canónica a partir del mime, con el nombre original como respaldo. */
function extFor(mime: string, name: string): string | null {
  const byMime = EXT_BY_MIME[mime.toLowerCase().split(";")[0].trim()];
  if (byMime) return byMime;
  const byName = extname(name).toLowerCase();
  return IMAGE_TYPES[byName] ? byName : null;
}

/**
 * Guarda una imagen y devuelve su id. Falla con mensaje legible (no excepción)
 * porque el que llama es una ruta HTTP y quiere devolver un 400 con la razón.
 */
export async function saveChatAttachment(input: {
  bytes: Uint8Array;
  mime: string;
  name?: string;
}): Promise<{ attachment?: ChatAttachment; error?: string }> {
  const name = (input.name || "imagen").slice(0, 120);
  const ext = extFor(input.mime, name);
  if (!ext) {
    return { error: `formato no soportado (${input.mime || "desconocido"}): usa PNG, JPG, WEBP o GIF` };
  }
  if (input.bytes.byteLength === 0) return { error: "el archivo llegó vacío" };
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    const mb = (input.bytes.byteLength / 1024 / 1024).toFixed(1);
    return { error: `la imagen pesa ${mb} MB (máximo ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)` };
  }

  await mkdir(DIR, { recursive: true });
  const id = randomUUID();
  const path = join(DIR, `${id}${ext}`);
  await writeFile(path, input.bytes);
  // Barrido oportunista: al subir, no en un timer. Sin proceso de fondo que
  // mantener y el disco no crece sin techo.
  void pruneChatAttachments();
  return {
    attachment: { id, name, mime: IMAGE_TYPES[ext], size: input.bytes.byteLength, path },
  };
}

/**
 * Ruta en disco de un id. Prueba las extensiones conocidas en vez de mantener
 * un índice: son cinco `existsSync` y el índice sería un estado más que puede
 * quedar desincronizado del disco.
 */
export function chatAttachmentPath(id: string): { path: string; mime: string } | null {
  if (!ID_RE.test(id)) return null;
  for (const [ext, mime] of Object.entries(IMAGE_TYPES)) {
    const path = join(DIR, `${id}${ext}`);
    if (existsSync(path)) return { path, mime };
  }
  return null;
}

/**
 * Ids → rutas absolutas, descartando en silencio lo que no exista. Un id
 * caducado (barrido a los 30 días) no debe tumbar el turno: el mensaje se
 * manda igual, solo sin esa imagen.
 */
export function resolveChatAttachments(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const raw of ids.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
    if (typeof raw !== "string") continue;
    const found = chatAttachmentPath(raw);
    if (found) out.push(found.path);
  }
  return out;
}

/**
 * El bloque que se le pone DELANTE al mensaje del usuario cuando hay imágenes.
 *
 * Es una orden, no un aviso: sin el "antes de responder" el modelo a veces
 * contesta sobre el texto y deja la imagen sin abrir, que es exactamente el
 * fallo que este flujo viene a evitar. Y se dice explícitamente que `Read`
 * sirve para imágenes porque, leído en frío, "lee este .png" suena a algo que
 * una tool de texto no podría hacer.
 */
export function attachmentPreamble(paths: string[]): string {
  if (paths.length === 0) return "";
  const plural = paths.length === 1 ? "una imagen" : `${paths.length} imágenes`;
  const list = paths.map((p) => `- ${p}`).join("\n");
  return [
    `[El usuario adjuntó ${plural} a este mensaje.`,
    `Ábrelas con la tool Read (soporta imágenes: te devuelve el contenido visual) ANTES de responder.`,
    `Si el mensaje señala un detalle visual —un margen, un color, un desalineado—, descríbelo por lo que VES en la imagen, no por lo que supongas del código.]`,
    "",
    list,
  ].join("\n");
}

/** Sufijo corto para el historial persistido: la ruta larga no aporta ahí. */
export function attachmentNote(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "\n\n[+1 imagen adjunta]" : `\n\n[+${count} imágenes adjuntas]`;
}

/** Borra adjuntos más viejos que RETAIN_MS. Best-effort: nunca lanza. */
export async function pruneChatAttachments(): Promise<void> {
  try {
    const cutoff = Date.now() - RETAIN_MS;
    for (const file of await readdir(DIR)) {
      const path = join(DIR, file);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
    }
  } catch {
    /* el directorio puede no existir todavía */
  }
}
