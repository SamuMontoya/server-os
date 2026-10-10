/**
 * Tests de la exportación de turnos a .docx/.md (Épica B, buzón B4).
 * `pnpm --filter @hermes/agent test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { turnToMarkdown, turnToDocx, exportTurn } from "./turn-export.js";
import type { ChatTurn } from "../agent/chat-turns.js";

function mockTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "abc12345-0000-0000-0000-000000000000",
    sessionKey: "s1",
    project: "jaime-os",
    prompt: "¿Qué día es hoy?",
    status: "done",
    text: "Hoy es 10 de octubre de 2026.",
    steps: [],
    files: [],
    ...overrides,
  } as ChatTurn;
}

test("turnToMarkdown: incluye proyecto, pregunta y respuesta", () => {
  const md = turnToMarkdown(mockTurn());
  assert.match(md, /abc12345/);
  assert.match(md, /jaime-os/);
  assert.match(md, /¿Qué día es hoy\?/);
  assert.match(md, /Hoy es 10 de octubre de 2026\./);
});

test("turnToMarkdown: sin archivos no agrega la sección de archivos", () => {
  const md = turnToMarkdown(mockTurn());
  assert.doesNotMatch(md, /Archivos generados/);
});

test("turnToMarkdown: con archivos los lista con su id", () => {
  const md = turnToMarkdown(
    mockTurn({ files: [{ id: "f1", name: "rubrica.docx", mime: "application/msword", size: 123 }] }),
  );
  assert.match(md, /Archivos generados/);
  assert.match(md, /rubrica\.docx/);
});

test("turnToDocx: genera un buffer no vacío (ZIP válido, firma PK)", async () => {
  const buffer = await turnToDocx(mockTurn());
  assert.ok(buffer.length > 0);
  // Un .docx es un ZIP: debe empezar con la firma "PK".
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
});

test("exportTurn: format=md devuelve mimeType text/markdown y filename .md", async () => {
  const { mimeType, filename, buffer } = await exportTurn(mockTurn(), "md");
  assert.equal(mimeType, "text/markdown");
  assert.match(filename, /^turno-abc12345-\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(buffer.length > 0);
});

test("exportTurn: format=docx devuelve el mimeType de Word y filename .docx", async () => {
  const { mimeType, filename } = await exportTurn(mockTurn(), "docx");
  assert.equal(
    mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.match(filename, /^turno-abc12345-\d{4}-\d{2}-\d{2}\.docx$/);
});

test("exportTurn: formato desconocido cae a md (default seguro)", async () => {
  // @ts-expect-error -- probando el fallback con un valor inválido
  const { mimeType } = await exportTurn(mockTurn(), "pdf");
  assert.equal(mimeType, "text/markdown");
});
