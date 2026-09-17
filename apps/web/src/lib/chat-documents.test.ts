import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDocProgress } from "./chat-documents";

/**
 * `formatDocProgress` — el texto "4/12 fragmentos (~30s)" que ven tanto el
 * chip del composer como la card de la burbuja ya enviada (auditoría
 * 2026-09-17: antes de esto, "processing" era un spinner mudo hasta minutos).
 * Mismo archivo que jaime-os/src/lib/chat-documents.test.ts — gemelos, misma
 * función, mismos casos.
 */

test("con chunksDone/chunksTotal y sin ETA: solo el conteo", () => {
  assert.equal(formatDocProgress({ chunksDone: 4, chunksTotal: 12 }), "4/12 fragmentos");
});

test("con ETA positivo: se agrega '(~Ns)' redondeado a segundos", () => {
  assert.equal(formatDocProgress({ chunksDone: 4, chunksTotal: 12, etaMs: 29_600 }), "4/12 fragmentos (~30s)");
});

test("ETA menor a 1000ms redondea a '~1s' (nunca '~0s', que leería como 'ya' sin estarlo)", () => {
  assert.equal(formatDocProgress({ chunksDone: 11, chunksTotal: 12, etaMs: 300 }), "11/12 fragmentos (~1s)");
});

test("ETA en 0 o negativo (ya no debería faltar nada): no se muestra ETA, solo el conteo", () => {
  assert.equal(formatDocProgress({ chunksDone: 12, chunksTotal: 12, etaMs: 0 }), "12/12 fragmentos");
  assert.equal(formatDocProgress({ chunksDone: 12, chunksTotal: 12, etaMs: -50 }), "12/12 fragmentos");
});

test("sin chunksTotal todavía (recién encolado, el servidor no terminó de trocear): null, no '0/undefined'", () => {
  assert.equal(formatDocProgress({}), null);
  assert.equal(formatDocProgress({ chunksDone: 0 }), null);
});

test("chunksTotal=0 (edge raro, documento sin fragmentos): también null, no '0/0 fragmentos' engañoso", () => {
  assert.equal(formatDocProgress({ chunksDone: 0, chunksTotal: 0 }), null);
});

test("sin chunksDone (todavía no llegó ningún avance real): se muestra '0/total', no revienta", () => {
  assert.equal(formatDocProgress({ chunksTotal: 8 }), "0/8 fragmentos");
});

test("singular: chunksTotal=1 dice 'fragmento', no 'fragmentos'", () => {
  assert.equal(formatDocProgress({ chunksDone: 0, chunksTotal: 1 }), "0/1 fragmento");
});

test("chunksDone nunca se muestra por encima de chunksTotal (clamp defensivo ante un dato inconsistente)", () => {
  assert.equal(formatDocProgress({ chunksDone: 15, chunksTotal: 12 }), "12/12 fragmentos");
});
