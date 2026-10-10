/**
 * Tests de los preámbulos que se le anteponen al mensaje del usuario cuando
 * hay adjuntos — `attachmentPreamble` (imágenes) no tenía NINGÚN test pese a
 * ser una pieza crítica (sin la orden explícita, el modelo a veces contesta
 * sobre el texto y nunca abre la imagen). `documentPreamble` es nuevo, fix
 * 2026-10-09 (Épica B, buzón #2 "en ocasiones no lee los documentos
 * adjuntos") — ver el comentario grande en chat-attachments.ts para la causa
 * raíz real.
 *
 * `pnpm --filter @hermes/agent test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { attachmentPreamble, documentPreamble, attachmentNote } from "./chat-attachments.js";

test("attachmentPreamble: sin imágenes, string vacío (no se antepone nada)", () => {
  assert.equal(attachmentPreamble([]), "");
});

test("attachmentPreamble: una imagen usa singular y lista la ruta", () => {
  const out = attachmentPreamble(["/tmp/foto.png"]);
  assert.match(out, /una imagen/);
  assert.match(out, /- \/tmp\/foto\.png/);
  assert.match(out, /Read/);
});

test("attachmentPreamble: varias imágenes usa plural y el conteo exacto", () => {
  const out = attachmentPreamble(["/a.png", "/b.jpg", "/c.webp"]);
  assert.match(out, /3 imágenes/);
  assert.match(out, /- \/a\.png/);
  assert.match(out, /- \/b\.jpg/);
  assert.match(out, /- \/c\.webp/);
});

test("documentPreamble: sin documentos, string vacío", () => {
  assert.equal(documentPreamble([]), "");
});

test("documentPreamble: un documento usa singular, nombra el archivo y ordena usar read_chat_document", () => {
  const out = documentPreamble(["Quiz 1 DBG11.xml"]);
  assert.match(out, /un documento/);
  assert.match(out, /- Quiz 1 DBG11\.xml/);
  assert.match(out, /read_chat_document/);
});

test("documentPreamble: varios documentos usa plural y lista TODOS los nombres", () => {
  const out = documentPreamble(["silabo.pdf", "rubrica.docx"]);
  assert.match(out, /2 documentos/);
  assert.match(out, /- silabo\.pdf/);
  assert.match(out, /- rubrica\.docx/);
});

test("documentPreamble: deja explícito que es un documento NUEVO en este mensaje (la causa raíz real del bug)", () => {
  const out = documentPreamble(["acta.pdf"]);
  assert.match(out, /NUEVO en este mensaje/);
});

test("attachmentNote: 0 adjuntos no agrega nada", () => {
  assert.equal(attachmentNote(0), "");
});

test("attachmentNote: singular vs. plural", () => {
  assert.equal(attachmentNote(1), "\n\n[+1 imagen adjunta]");
  assert.equal(attachmentNote(3), "\n\n[+3 imágenes adjuntas]");
});
