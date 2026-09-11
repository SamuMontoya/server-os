/**
 * Extracción de texto plano desde un buffer (de Drive o de un upload manual
 * del chat). Soporta PDF, DOCX, XLSX y texto plano (TXT/MD/CSV/JSON) — los
 * formatos "que la mayoría soporta" sin arrastrar parsers pesados de más.
 * Cualquier otro mimeType/extensión devuelve "" y el caller lo cuenta como
 * "sin texto extraíble" en vez de fallar.
 */

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Texto plano de verdad: se decodifica tal cual, sin parser de por medio. */
const PLAIN_TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const PLAIN_TEXT_MIME_PREFIXES = ["text/", "application/json"];

export async function extractText(buf: Buffer, mimeType: string, name: string): Promise<string> {
  const lower = name.toLowerCase();
  try {
    if (mimeType === PDF_MIME || lower.endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const res = await parser.getText();
      return res.text ?? "";
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
    const ext = lower.slice(lower.lastIndexOf("."));
    if (PLAIN_TEXT_EXT.has(ext) || PLAIN_TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
      return buf.toString("utf8");
    }
  } catch (err) {
    console.error(`[drive] extracción falló (${name}):`, (err as Error).message);
    return "";
  }
  return ""; // tipo no soportado (imágenes, audio, .pptx/.doc/.xls legado, etc.)
}
