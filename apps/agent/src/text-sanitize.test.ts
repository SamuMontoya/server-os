/**
 * Tests de `sanitizeExtractedText` — el saneador de bytes de control que
 * evita que un insert a Postgres truene con "unsupported Unicode escape
 * sequence" cuando un PDF/DOCX deja colar basura binaria en el texto.
 *
 * Los caracteres de control se arman con `String.fromCharCode` a propósito
 * (nunca como bytes crudos en el código fuente): el propio comentario de
 * text-sanitize.ts explica que un literal con esos bytes puestos a mano hace
 * que git detecte el archivo entero como binario.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeExtractedText } from "./text-sanitize.js";

const chr = (code: number) => String.fromCharCode(code);

test("happy path: texto normal pasa intacto", () => {
  const text = "Hola, este es un párrafo normal con ñ, tildes y números 123.";
  assert.equal(sanitizeExtractedText(text), text);
});

test("edge: quita NUL (0x00), la causa real del fallo de Postgres", () => {
  const dirty = `antes${chr(0)}despues`;
  assert.equal(sanitizeExtractedText(dirty), "antesdespues");
});

test("edge: quita el resto de caracteres de control (0x01-0x08, 0x0B, 0x0C, 0x0E-0x1F)", () => {
  // Un char de control de cada sub-rango que cubre la regex, intercalado.
  const controlChars = [1, 5, 8, 0x0b, 0x0c, 0x0e, 0x1f];
  const dirty = controlChars.map((c, i) => `letra${i}${chr(c)}`).join("");
  const expected = controlChars.map((_, i) => `letra${i}`).join("");
  assert.equal(sanitizeExtractedText(dirty), expected);
});

test("edge: preserva \\n, \\r y \\t (saltos de línea y tabs son contenido válido, no basura binaria)", () => {
  const text = "linea1\nlinea2\r\ncolumna1\tcolumna2";
  assert.equal(sanitizeExtractedText(text), text);
});

test("edge: string vacío no truena", () => {
  assert.equal(sanitizeExtractedText(""), "");
});

test("edge: string de solo caracteres de control queda vacío", () => {
  const dirty = [0, 1, 2, 0x1f].map(chr).join("");
  assert.equal(sanitizeExtractedText(dirty), "");
});

test("edge: no toca emojis ni otros caracteres unicode altos", () => {
  const text = "reporte 📊 con ñoños y 中文";
  assert.equal(sanitizeExtractedText(text), text);
});
