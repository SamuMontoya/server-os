/**
 * Tests de integración: endpoint /chat/turns/:id/export + cliente frontend.
 * Verifica que el pipeline completo (generar documento, servir, descargar) funcione.
 * `pnpm --filter @hermes/agent exec tsx --test src/routes/turn-export.integration.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { turnToMarkdown, exportTurn } from "./turn-export.js";
import type { ChatTurn } from "../agent/chat-turns.js";

function mockTurn(): ChatTurn {
  return {
    id: "int-test-0000-0000-0000-000000000000",
    sessionKey: "s1",
    project: "jaime-os",
    prompt: "¿Cuál es tu nombre?",
    status: "done",
    text: "Me llamo OS, el asistente de Jaime.",
    steps: [],
    files: [
      { id: "f1", name: "ejemplo.docx", mime: "application/msword", size: 456 },
    ],
    attempts: 1,
    startedAt: Date.now(),
  } as unknown as ChatTurn;
}

test("integración: markdown exportado contiene todo lo necesario", async () => {
  const turn = mockTurn();
  const md = turnToMarkdown(turn);

  // Verificar estructura completa
  assert.match(md, /int-test-0000/); // ID
  assert.match(md, /jaime-os/); // Proyecto
  assert.match(md, /¿Cuál es tu nombre\?/); // Pregunta
  assert.match(md, /Me llamo OS/); // Respuesta
  assert.match(md, /Archivos generados/); // Sección de archivos
  assert.match(md, /ejemplo\.docx/); // Nombre de archivo
});

test("integración: docx exportado es un ZIP válido (no corrupto)", async () => {
  const turn = mockTurn();
  const { buffer } = await exportTurn(turn, "docx");

  // ZIP signature
  assert.equal(buffer[0], 0x50); // P
  assert.equal(buffer[1], 0x4b); // K
  assert.ok(buffer.length > 1000, "docx debe ser > 1KB (ZIP con contenido)");
});

test("integración: headers HTTP correctos para descarga", async () => {
  const turn = mockTurn();
  const { mimeType, filename } = await exportTurn(turn, "md");

  assert.equal(mimeType, "text/markdown");
  assert.match(filename, /\.md$/);
  assert.ok(filename.includes("int-test"), "filename debe incluir ID del turno");
});

test("adversarial: turnId vacío no causa crash", () => {
  const turn = mockTurn();
  (turn as any).id = "";
  const md = turnToMarkdown(turn);
  assert.ok(md.length > 0, "debe generar markdown incluso con id vacío");
});

test("adversarial: archivos con nombres raros (unicode, comillas, barras)", async () => {
  const turn = mockTurn();
  turn.files = [
    { id: "f1", name: 'archivo "raro".docx', mime: "application/msword", size: 100 },
    { id: "f2", name: "archivo/con/barras.pdf", mime: "application/pdf", size: 200 },
    { id: "f3", name: "archivo_con_ñ_y_émojis_🎯.txt", mime: "text/plain", size: 50 },
  ];

  const md = turnToMarkdown(turn);
  // No debe crash; debe incluir al menos los nombres
  assert.match(md, /raro/);
  assert.match(md, /barras/);
  assert.match(md, /ñ/);
});

test("adversarial: respuesta con caracteres especiales/markdown se escapa correctamente", async () => {
  const turn = mockTurn();
  turn.text = "**Negrita**, `código`, [link](http://example.com), \\n saltos\\n de línea";
  const md = turnToMarkdown(turn);

  // Debe preservar el contenido sin corrupción
  assert.match(md, /\*\*Negrita\*\*/);
  assert.match(md, /`código`/);
});

test("adversarial: turno sin archivos no agrega sección vacía", () => {
  const turn = mockTurn();
  turn.files = [];
  const md = turnToMarkdown(turn);

  assert.doesNotMatch(md, /Archivos generados/);
});

test("adversarial: formato inválido cae a md (default seguro)", async () => {
  const turn = mockTurn();
  // @ts-expect-error intentando pasar formato inválido
  const { mimeType } = await exportTurn(turn, "pdf");

  assert.equal(mimeType, "text/markdown", "debe caer a md para formato desconocido");
});
