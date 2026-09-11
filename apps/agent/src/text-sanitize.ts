/**
 * Saneo de texto extraído (PDF/DOCX/XLSX/TXT/...) antes de guardarlo en
 * Postgres. Compartido por drive/sync.ts y documents/chat-documents.ts para
 * no duplicar esta regex dos veces.
 */

/**
 * Postgres `text` rechaza el byte NUL (U+0000), que algunos PDF/DOCX dejan
 * colar en la extracción. Se limpia junto con el resto de caracteres de
 * control (se preservan \n \r \t): si no, el insert/upsert entero del batch
 * falla con "unsupported Unicode escape sequence".
 *
 * Construido con `new RegExp(string)` a propósito: un literal `/[...]/ ` con
 * los bytes de control puestos directamente en el código fuente hace que git
 * (y algunos editores) detecten el ARCHIVO ENTERO como binario.
 */
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

export function sanitizeExtractedText(text: string): string {
  return text.replace(CONTROL_CHARS_RE, "");
}
