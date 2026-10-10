/**
 * Empaquetado de imágenes sugeridas (para diapositivas) en un .zip
 * descargable, con URLs VERIFICADAS — no basta con que el modelo las haya
 * escrito en el texto: antes de empaquetar se confirma que cada URL responde
 * 200 y es realmente una imagen (buzón B5, pedido explícito "URLs
 * verificadas, no inventadas" — el modelo alucina URLs de imágenes con
 * cierta frecuencia, sobre todo de bancos de imágenes que ya no existen o
 * rutas que nunca existieron).
 */
import { ZipArchive } from "archiver";
import type { PassThrough } from "node:stream";
import type { ChatTurn } from "../agent/chat-turns.js";

export interface ImageCandidate {
  url: string;
  /** Texto alt del markdown `![alt](url)`, si lo tenía. */
  alt?: string;
}

export interface VerifiedImage extends ImageCandidate {
  ok: boolean;
  /** Motivo del fallo, para que el reporte final no mienta ("no se pudo
   *  verificar" en vez de fingir que no existía). */
  error?: string;
  contentType?: string;
  bytes?: number;
}

const IMAGE_CONTENT_TYPE_RE = /^image\//i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i;

/** Extensiones/mime-types excluidos a propósito: SVG puede ser un vector
 *  decorativo sin valor para una diapositiva, pero lo dejamos pasar si el
 *  server lo sirve como image/svg+xml — la decisión de usarlo o no es de
 *  quien arma la diapositiva, no nuestra acá. */
const MAX_IMAGES = 30;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB por imagen — una diapositiva no necesita más.

/**
 * Extrae candidatos de imagen del texto de una respuesta: markdown
 * `![alt](url)` y URLs sueltas que terminen en extensión de imagen. No
 * asume que son válidas — eso lo decide `verifyImageUrl`.
 */
export function extractImageUrls(text: string): ImageCandidate[] {
  const found = new Map<string, ImageCandidate>();

  // 1) Markdown: ![alt](url)
  const mdRe = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text))) {
    const url = m[2];
    if (!found.has(url)) found.set(url, { url, alt: m[1] || undefined });
  }

  // 2) URLs sueltas (no en formato markdown) que terminan en extensión de
  //    imagen — cubre el caso de que el modelo solo pegue el link plano.
  const bareRe = /https?:\/\/[^\s)]+/g;
  while ((m = bareRe.exec(text))) {
    const url = m[0].replace(/[.,;:]+$/, ""); // puntuación de cierre de frase
    if (IMAGE_EXT_RE.test(url) && !found.has(url)) {
      found.set(url, { url });
    }
  }

  return Array.from(found.values()).slice(0, MAX_IMAGES);
}

/**
 * Verifica una URL de imagen con HEAD (fallback a GET si el servidor no
 * soporta HEAD, algo común en CDNs de bancos de imágenes). No descarga el
 * cuerpo completo en la verificación — eso se hace aparte, solo para las
 * que pasan.
 */
export async function verifyImageUrl(candidate: ImageCandidate): Promise<VerifiedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(candidate.url, { method: "HEAD", signal: controller.signal }).catch(() => null);
    if (!res || !res.ok) {
      // Algunos servidores no implementan HEAD (405/501) o lo bloquean:
      // reintentar con GET es más caro pero evita falsos negativos.
      res = await fetch(candidate.url, { method: "GET", signal: controller.signal });
    }
    clearTimeout(timeout);

    if (!res.ok) {
      return { ...candidate, ok: false, error: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!IMAGE_CONTENT_TYPE_RE.test(contentType)) {
      return { ...candidate, ok: false, error: `no es una imagen (content-type: ${contentType || "desconocido"})` };
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) {
      return { ...candidate, ok: false, error: `demasiado pesada (${Math.round(len / 1024 / 1024)}MB)` };
    }
    return { ...candidate, ok: true, contentType, bytes: len || undefined };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return { ...candidate, ok: false, error: msg.includes("abort") ? "tiempo de espera agotado" : msg };
  }
}

/** Verifica todas las candidatas en paralelo (con tope razonable: ya se
 *  limitó a MAX_IMAGES arriba, así que no hace falta otro throttle). */
export async function verifyAll(candidates: ImageCandidate[]): Promise<VerifiedImage[]> {
  return Promise.all(candidates.map(verifyImageUrl));
}

function filenameFor(url: string, alt: string | undefined, index: number): string {
  const extMatch = IMAGE_EXT_RE.exec(url);
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  const base = (alt || `imagen-${index + 1}`)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes (marcas diacríticas combinantes)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `imagen-${index + 1}`;
  return `${String(index + 1).padStart(2, "0")}-${base}.${ext}`;
}

export interface ImageZipResult {
  /** El propio archive ES el stream legible (ZipArchive extiende Transform
   *  de archiver v8) — se pasa directo a la respuesta HTTP, nada se
   *  materializa a disco. */
  stream: ZipArchive;
  /** Reporte de qué entró y qué no — va dentro del zip como reporte.md y
   *  también se puede devolver aparte para mostrar antes de descargar. */
  report: { total: number; empaquetadas: number; descartadas: VerifiedImage[] };
}

/**
 * Arma el .zip con las imágenes VERIFICADAS de un turno. Las que fallaron
 * verificación no se empaquetan — en vez de fingir éxito, quedan listadas en
 * un `reporte.md` dentro del mismo zip, con el motivo exacto del descarte
 * (alucinación del modelo vs. link roto vs. demasiado pesada).
 */
export async function buildImageZip(turn: ChatTurn): Promise<ImageZipResult> {
  const candidates = extractImageUrls(turn.text || "");
  const verified = await verifyAll(candidates);
  const ok = verified.filter((v) => v.ok);
  const failed = verified.filter((v) => !v.ok);

  const archive = new ZipArchive({ zlib: { level: 6 } });

  // Descargar y añadir cada imagen verificada. Si una falla a último momento
  // (red se cayó entre el HEAD y ahora), se mueve al reporte en vez de
  // tronar el zip entero.
  const fallosTardios: VerifiedImage[] = [];
  for (let i = 0; i < ok.length; i++) {
    const img = ok[i];
    try {
      const res = await fetch(img.url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      archive.append(buffer, { name: filenameFor(img.url, img.alt, i) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fallosTardios.push({ ...img, ok: false, error: `falló al descargar (verificación previa OK): ${msg}` });
    }
  }

  const descartadas = [...failed, ...fallosTardios];
  const empaquetadas = ok.length - fallosTardios.length;

  const reporteLines = [
    `# Reporte de empaquetado de imágenes`,
    ``,
    `Turno: ${turn.id}`,
    `Candidatas encontradas en la respuesta: ${candidates.length}`,
    `Empaquetadas (verificadas y descargadas): ${empaquetadas}`,
    `Descartadas: ${descartadas.length}`,
    ``,
  ];
  if (descartadas.length) {
    reporteLines.push(`## Descartadas (no se incluyeron en el zip)`, ``);
    descartadas.forEach((d) => {
      reporteLines.push(`- ${d.url}${d.alt ? ` ("${d.alt}")` : ""}: ${d.error}`);
    });
  }
  archive.append(reporteLines.join("\n"), { name: "reporte.md" });

  void archive.finalize();

  return {
    stream: archive,
    report: { total: candidates.length, empaquetadas, descartadas },
  };
}
