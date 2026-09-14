/**
 * OCR de imágenes y PDFs escaneados (sin capa de texto) vía Tesseract CLI.
 *
 * Se usa como fallback en extract.ts cuando el mimeType es una imagen o
 * cuando un PDF no trae texto embebido (páginas escaneadas / fotografiadas).
 * Requiere el binario `tesseract` instalado en el sistema (con datos de
 * idioma `spa`+`eng`) y, para PDFs, `pdftoppm` (poppler-utils) para
 * rasterizar páginas antes de pasarlas a Tesseract.
 *
 * Si los binarios no están disponibles, ambas funciones devuelven "" en vez
 * de reventar el sync completo — el caller lo trata igual que "sin texto".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const TESSERACT_LANG = "spa+eng";
// Cota dura: rasterizar+OCRear es lento. No vale la pena procesar un deck de
// 100 páginas completo solo para saber que las primeras ya dan contexto.
const MAX_PDF_PAGES_OCR = 15;

async function runTesseract(imagePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "-l", TESSERACT_LANG, "--psm", "3"],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    console.error(`[drive] tesseract falló (${imagePath}):`, (err as Error).message);
    return "";
  }
}

/** OCR directo sobre una imagen (jpg/png/webp/bmp/tiff/gif) en memoria. */
export async function ocrImage(buf: Buffer, ext: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drive-ocr-"));
  try {
    const path = join(dir, `img${ext}`);
    await writeFile(path, buf);
    return await runTesseract(path);
  } catch (err) {
    console.error("[drive] ocrImage falló:", (err as Error).message);
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rasteriza un PDF (poppler `pdftoppm`) y OCRea cada página, hasta un tope. */
export async function ocrPdf(buf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drive-ocr-pdf-"));
  try {
    const pdfPath = join(dir, "doc.pdf");
    await writeFile(pdfPath, buf);
    await execFileAsync("pdftoppm", [
      "-png",
      "-r",
      "150",
      "-f",
      "1",
      "-l",
      String(MAX_PDF_PAGES_OCR),
      pdfPath,
      join(dir, "page"),
    ]);
    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    const texts: string[] = [];
    for (const f of files) {
      const text = await runTesseract(join(dir, f));
      if (text.trim()) texts.push(text);
    }
    return texts.join("\n\n");
  } catch (err) {
    console.error("[drive] ocrPdf falló:", (err as Error).message);
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
