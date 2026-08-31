/**
 * Tests de la persistencia del hilo:  pnpm --filter @hermes/web test
 *
 * El caso que importa es el que rompía: guardar, "matar la pestaña", volver a
 * leer y encontrar la conversación intacta — incluido el turno que quedó
 * corriendo mientras la pantalla estaba bloqueada.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeChat,
  parseChat,
  trimTab,
  SCHEMA_VERSION,
  type ChatTab,
  type TabsState,
} from "./chat-persist.js";

const NOW = 1_700_000_000_000;

const tab = (over: Partial<ChatTab> = {}): ChatTab => ({
  key: "tab-1",
  sdkSessionId: null,
  title: "",
  messages: [],
  steps: {},
  draft: "",
  busy: false,
  ...over,
});

const state = (tabs: ChatTab[]): TabsState => ({ tabs, active: tabs[0]?.key ?? "" });

const conversation = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `m${i}`,
  }));

/** Ida y vuelta completa por el mismo camino que usa el navegador. */
function roundTrip(byProject: Record<string, TabsState>, now = NOW) {
  const raw = serializeChat(byProject, now);
  return raw === null ? null : parseChat(raw, now);
}

test("el hilo sobrevive a que la pestaña muera", () => {
  const t = tab({
    messages: conversation(4),
    sdkSessionId: "sdk-7",
    title: "revisar el deploy",
    steps: { 1: [{ name: "Read", target: "index.ts" }] },
  });
  const back = roundTrip({ general: state([t]) })!;
  assert.equal(back.general.tabs.length, 1);
  assert.deepEqual(back.general.tabs[0].messages, conversation(4));
  assert.equal(back.general.tabs[0].sdkSessionId, "sdk-7", "resume del SDK conservado");
  assert.equal(back.general.tabs[0].title, "revisar el deploy");
  assert.deepEqual(back.general.tabs[0].steps[1], [{ name: "Read", target: "index.ts" }]);
});

test("el turno en vuelo se guarda con su cursor", () => {
  // Es lo que permite volver y re-engancharse en vez de ver el hilo cortado.
  const t = tab({ messages: conversation(2), pendingTurn: { id: "turn-9", seq: 42 } });
  const back = roundTrip({ general: state([t]) })!;
  assert.deepEqual(back.general.tabs[0].pendingTurn, { id: "turn-9", seq: 42 });
});

test("busy nunca vuelve en true", () => {
  // Un `busy` fósil dejaba el composer bloqueado sin nada corriendo detrás.
  const t = tab({ messages: conversation(2), busy: true });
  const back = roundTrip({ general: state([t]) })!;
  assert.equal(back.general.tabs[0].busy, false);
});

test("el borrador a medio escribir se conserva", () => {
  const t = tab({ draft: "oye, sobre el build de ayer" });
  const back = roundTrip({ general: state([t]) })!;
  assert.equal(back.general.tabs[0].draft, "oye, sobre el build de ayer");
});

test("un tab virgen no se guarda", () => {
  assert.equal(serializeChat({ general: state([tab()]) }, NOW), null);
});

test("recortar mensajes corre los pasos con ellos", () => {
  // Los pasos se indexan por posición: sin correrlos quedan colgando del
  // mensaje equivocado y la UI atribuye herramientas a la respuesta que no fue.
  const t = tab({ messages: conversation(10), steps: { 0: [{ name: "A", target: "" }], 9: [{ name: "B", target: "" }] } });
  const trimmed = trimTab(t, 4);
  assert.equal(trimmed.messages.length, 4);
  assert.deepEqual(trimmed.messages.map((m) => m.content), ["m6", "m7", "m8", "m9"]);
  assert.equal(trimmed.steps[0], undefined, "el paso del mensaje botado se va");
  assert.deepEqual(trimmed.steps[3], [{ name: "B", target: "" }], "y el que queda se recoloca");
});

test("un mensaje gigante se recorta en vez de tirar la cuota", () => {
  const t = tab({ messages: [{ role: "assistant", content: "x".repeat(50_000) }] });
  const back = roundTrip({ general: state([t]) })!;
  const content = back.general.tabs[0].messages[0].content;
  assert.ok(content.length < 20_000, `quedó en ${content.length}`);
  assert.match(content, /recortado/);
});

test("una conversación enorme se guarda igual, recortada", () => {
  const big = tab({ messages: conversation(400).map((m) => ({ ...m, content: m.content.repeat(400) })) });
  const back = roundTrip({ general: state([big]) });
  assert.ok(back, "algo se tiene que guardar");
  assert.ok(back!.general.tabs[0].messages.length > 0);
});

test("si el tab activo se cae del recorte, manda otro", () => {
  const tabs = Array.from({ length: 12 }, (_, i) =>
    tab({ key: `t${i}`, messages: conversation(2) }),
  );
  const back = roundTrip({ general: { tabs, active: "t0" } })!;
  assert.ok(back.general.tabs.some((t) => t.key === back.general.active), "el activo existe");
});

test("los tabs de cada proyecto se guardan por separado", () => {
  const back = roundTrip({
    general: state([tab({ key: "g1", messages: conversation(2) })]),
    "server-os": state([tab({ key: "s1", messages: conversation(2) })]),
  })!;
  assert.deepEqual(Object.keys(back).sort(), ["general", "server-os"]);
});

test("basura guardada no rompe el arranque", () => {
  for (const raw of [
    null,
    "",
    "{",
    "null",
    "[]",
    '{"v":999,"byProject":{}}',
    '{"v":1,"byProject":null}',
    '{"v":1,"byProject":{"general":{"tabs":"no"}}}',
    `{"v":${SCHEMA_VERSION},"byProject":{"general":{"tabs":[{"key":1}]}}}`,
  ])
    assert.equal(parseChat(raw, NOW), null, JSON.stringify(raw));
});

test("un mensaje corrupto no arrastra al tab entero", () => {
  const raw = JSON.stringify({
    v: SCHEMA_VERSION,
    savedAt: NOW,
    byProject: {
      general: {
        active: "ok",
        tabs: [
          { key: "malo", messages: [{ role: "quien", content: 3 }] },
          { key: "ok", messages: conversation(2), steps: {}, draft: "", busy: false },
        ],
      },
    },
  });
  const back = parseChat(raw, NOW)!;
  assert.deepEqual(back.general.tabs.map((t) => t.key), ["ok"]);
});

test("lo guardado hace dos semanas se descarta", () => {
  const raw = serializeChat({ general: state([tab({ messages: conversation(2) })]) }, NOW)!;
  assert.ok(parseChat(raw, NOW + 13 * 24 * 3600_000), "13 días todavía sirve");
  assert.equal(parseChat(raw, NOW + 15 * 24 * 3600_000), null, "15 días ya no");
});
