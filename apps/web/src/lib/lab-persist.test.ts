import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLab, parseLab, type LabThread } from "./lab-persist";

const AHORA = 1_700_000_000_000;

function hilo(over: Partial<LabThread> = {}): LabThread {
  return {
    sdkSessionId: "sdk-1",
    sessionKey: "sesion-1",
    messages: [
      { id: 1, role: "user", content: "hola" },
      { id: 2, role: "assistant", content: "", blocks: [{ kind: "text", text: "qué tal" }] },
    ],
    draft: "",
    model: "sonnet",
    ...over,
  };
}

const ida = (by: Record<string, LabThread>, now = AHORA) =>
  parseLab(serializeLab(by, now), now);

test("un hilo va y vuelve igual", () => {
  const out = ida({ general: hilo() });
  assert.deepEqual(out?.general.messages, hilo().messages);
  assert.equal(out?.general.sdkSessionId, "sdk-1");
  assert.equal(out?.general.sessionKey, "sesion-1");
  assert.equal(out?.general.model, "sonnet");
});

test("el turno pendiente se guarda: es lo que permite reengancharse", () => {
  const out = ida({ general: hilo({ pendingTurn: { id: "t-9", seq: 42 } }) });
  assert.deepEqual(out?.general.pendingTurn, { id: "t-9", seq: 42 });
});

test("el borrador sin enviar se conserva", () => {
  const out = ida({ general: hilo({ draft: "a medio escribir" }) });
  assert.equal(out?.general.draft, "a medio escribir");
});

test("las imágenes NO se persisten: sus object URLs mueren con la página", () => {
  const conImg = hilo({
    messages: [{ id: 1, role: "user", content: "mira", images: [{ url: "blob:x", name: "a.png" }] }],
  });
  const out = ida({ general: conImg });
  assert.equal(out?.general.messages[0].images, undefined);
});

test("un hilo virgen no ocupa cuota", () => {
  assert.equal(serializeLab({ general: hilo({ messages: [], draft: "" }) }, AHORA), null);
});

test("cada proyecto guarda su propio hilo", () => {
  const out = ida({
    general: hilo(),
    zylen: hilo({ messages: [{ id: 7, role: "user", content: "solo de zylen" }] }),
  });
  assert.equal(out?.general.messages.length, 2);
  assert.equal(out?.zylen.messages[0].content, "solo de zylen");
});

test("basura guardada no rompe el arranque", () => {
  assert.equal(parseLab("{no es json", AHORA), null);
  assert.equal(parseLab(null, AHORA), null);
  assert.equal(parseLab(JSON.stringify({ v: 99, byProject: {} }), AHORA), null);
});

test("lo guardado hace dos semanas se descarta", () => {
  const raw = serializeLab({ general: hilo() }, AHORA);
  const quinceDias = 15 * 24 * 60 * 60 * 1000;
  assert.equal(parseLab(raw, AHORA + quinceDias), null);
});

test("un hilo con mensajes corruptos se descarta entero, sin tumbar el resto", () => {
  const raw = JSON.stringify({
    v: 1,
    savedAt: AHORA,
    byProject: {
      malo: { sdkSessionId: null, sessionKey: "x", messages: [{ nada: true }], draft: "", model: null },
      bueno: hilo(),
    },
  });
  const out = parseLab(raw, AHORA);
  assert.equal(out?.malo, undefined);
  assert.equal(out?.bueno.messages.length, 2);
});

test("una conversación enorme se recorta en vez de no guardarse", () => {
  const gordo = hilo({
    messages: Array.from({ length: 400 }, (_, i) => ({
      id: i,
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "x".repeat(3000),
    })),
  });
  const out = ida({ general: gordo });
  assert.ok(out, "debe guardar algo, no rendirse");
  assert.ok(out!.general.messages.length <= 60, "recortado a los últimos mensajes");
  // Lo que se conserva es el FINAL de la conversación, que es lo que se lee.
  assert.equal(out!.general.messages.at(-1)?.id, 399);
});
