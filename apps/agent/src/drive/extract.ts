/**
 * Extracción de texto plano desde un buffer descargado de Drive.
 * Soporta PDF, DOCX y XLSX (los formatos que aparecen en syllabus/planes de
 * curso). Cualquier otro mimeType devuelve "" y el caller lo cuenta como
 * "sin texto extraíble" en vez de fallar.
 */

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  } catch (err) {
    console.error(`[drive] extracción falló (${name}):`, (err as Error).message);
    return "";
  }
  return ""; // tipo no soportado (imágenes, audio, etc.)
}
