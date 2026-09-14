/**
 * Extracción de texto plano desde un buffer (de Drive o de un upload manual
 * del chat). Soporta PDF, DOCX, XLSX, PPTX, EPUB, texto plano (TXT/MD/CSV/JSON),
 * SVG (texto embebido en el XML) e imágenes/PDFs escaneados vía OCR
 * (Tesseract). Cualquier otro mimeType/extensión (RAW de cámara, PSD,
 * fuentes, zips genéricos, audio/video, .doc/.xls/.ppt legado sin XML)
 * devuelve "" y el caller lo cuenta como "sin texto extraíble" en vez de
 * fallar — no tiene texto real que rescatar.
 */
import { ocrImage, ocrPdf } from "./ocr.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const EPUB_MIME = "application/epub+zip";

/** Texto plano de verdad: se decodifica tal cual, sin parser de por medio. */
const PLAIN_TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const PLAIN_TEXT_MIME_PREFIXES = ["text/", "application/json"];

/** Extensiones de imagen que Tesseract/leptonica decodifican directo. */
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/gif": ".gif",
};

/** Por debajo de esto, un PDF se trata como escaneado (sin capa de texto real). */
const MIN_PDF_TEXT_LEN = 40;

export async function extractText(buf: Buffer, mimeType: string, name: string): Promise<string> {
  const lower = name.toLowerCase();
  try {
    if (mimeType === PDF_MIME || lower.endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const res = await parser.getText();
      const text = res.text ?? "";
      if (text.trim().length >= MIN_PDF_TEXT_LEN) return text;
      // Sin capa de texto real (escaneado/fotografiado): OCR de las páginas.
      const ocrText = await ocrPdf(buf);
      return ocrText || text;
    }
    if (mimeType === DOCX_MIME || lower.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const res = await mammoth.extractRawText({ buffer: buf });
      return res.value ?? "";
    }
    if (mimeType === XLSX_MIME || lower.endsWith(".xlsx")) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(buf, { type: "buffer" });
      let out = "";
      for (const sheetName of wb.SheetNames) {
        out += `\n## ${sheetName}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sheetName])}`;
      }
      return out;
    }
    if (mimeType === PPTX_MIME || lower.endsWith(".pptx")) {
      return await extractPptxText(buf);
    }
    if (mimeType === EPUB_MIME || lower.endsWith(".epub")) {
      return await extractEpubText(buf);
    }
    const imgExt = IMAGE_EXT_BY_MIME[mimeType];
    if (imgExt) {
      return await ocrImage(buf, imgExt);
    }

    if (mimeType === "image/svg+xml" || lower.endsWith(".svg")) {
      const raw = buf.toString("utf8");
      const matches = [...raw.matchAll(/<(?:text|title|desc)[^>]*>([\s\S]*?)<\/(?:text|title|desc)>/gi)];
      return matches.map((m) => m[1].replace(/<[^>]+>/g, " ")).join("\n");
    }

    const ext = lower.slice(lower.lastIndexOf("."));
    if (PLAIN_TEXT_EXT.has(ext) || PLAIN_TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
      return buf.toString("utf8");
    }
  } catch (err) {
    console.error(`[drive] extracción falló (${name}):`, (err as Error).message);
    return "";
  }
  return ""; // tipo no soportado (RAW de cámara, PSD, fuentes, zips, audio/video, .doc/.xls/.ppt legado, etc.)
}

/**
 * PPTX es un zip de XML: cada slide vive en ppt/slides/slideN.xml con el
 * texto en corridas <a:t>. Se leen en orden numérico (no alfabético: slide10
 * < slide2 con sort de string) y también las notas del orador
 * (ppt/notesSlides/notesSlideN.xml), que suelen tener el guion completo.
 */
async function extractPptxText(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);

  const slideNum = (path: string) => Number(path.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const textOf = async (path: string): Promise<string> => {
    const entry = zip.file(path);
    if (!entry) return "";
    const xml = await entry.async("text");
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
    return runs.join(" ");
  };

  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNum(a) - slideNum(b));

  const parts: string[] = [];
  for (const path of slidePaths) {
    const text = await textOf(path);
    if (text.trim()) parts.push(`-- slide ${slideNum(path)} --\n${text}`);
    const notesPath = path.replace("slides/slide", "notesSlides/notesSlide");
    const notes = await textOf(notesPath);
    if (notes.trim()) parts.push(`(notas) ${notes}`);
  }
  return parts.join("\n\n");
}

/** Entidades HTML más comunes en contenido EPUB; no vale la pena un parser XML completo para esto. */
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function stripHtml(html: string): string {
  // Fuera scripts/estilos completos (su contenido no es texto legible).
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const noTags = noScripts.replace(/<[^>]+>/g, " ");
  const decoded = noTags.replace(/&#?\w+;/g, (e) => HTML_ENTITIES[e] ?? e);
  return decoded.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * EPUB es un zip: META-INF/container.xml apunta al .opf (el "manifest" del
 * libro), que a su vez lista todos los archivos (manifest) y el orden de
 * lectura (spine, por idref). La ruta del .opf NO es fija (a veces
 * OEBPS/content.opf, a veces en la raíz, etc.) — hay que resolverla desde
 * container.xml en vez de asumir una carpeta. Se leen los XHTML del spine en
 * orden y se les quita el markup; las imágenes embebidas y el CSS se pierden
 * (no hay texto que rescatar ahí), igual que con PPTX/DOCX no se rescatan
 * imágenes.
 */
async function extractEpubText(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);

  const containerXml = await zip.file("META-INF/container.xml")?.async("text");
  const opfPath = containerXml?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) return "";

  const opfXml = await zip.file(opfPath)?.async("text");
  if (!opfXml) return "";
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  // manifest: id -> href (solo nos interesan los documentos XHTML/HTML)
  const manifestMatch = opfXml.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
  const hrefById: Record<string, string> = {};
  if (manifestMatch) {
    for (const item of manifestMatch[1].matchAll(/<item\b[^>]*\/?>/gi)) {
      const tag = item[0];
      const id = tag.match(/\bid="([^"]+)"/)?.[1];
      const href = tag.match(/\bhref="([^"]+)"/)?.[1];
      if (id && href) hrefById[id] = href;
    }
  }

  // spine: orden de lectura por idref
  const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
  const idrefs = spineMatch
    ? [...spineMatch[1].matchAll(/idref="([^"]+)"/g)].map((m) => m[1])
    : [];

  const readOrder = idrefs.length > 0 ? idrefs.map((id) => hrefById[id]).filter(Boolean) : Object.values(hrefById);

  const parts: string[] = [];
  for (const href of readOrder) {
    if (!href || !/\.x?html?$/i.test(href)) continue; // fuera CSS/fuentes/imágenes del manifest
    const fullPath = opfDir + href;
    const html = await zip.file(fullPath)?.async("text");
    if (!html) continue;
    const text = stripHtml(html);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}
