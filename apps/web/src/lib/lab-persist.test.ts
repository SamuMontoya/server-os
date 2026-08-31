import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLab, parseLab, chatStorageKey, type LabThread } from "./lab-persist";

const AHORA = 1_700_000_000_000;

function hilo(id: string, over: Partial<LabThread> = {}): LabThread {
  return {
    id,
    archived: false,
    updatedAt: AHORA,
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

const ida = (
  byChat: Record<string, LabThread>,
  activeByProject: Record<string, string> = {},
  now = AHORA,
) => parseLab(serializeLab(byChat, activeByProject, now), now);

test("un hilo va y vuelve igual", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1") }, { general: "c1" });
  assert.deepEqual(out?.byChat[key].messages, hilo("c1").messages);
  assert.equal(out?.byChat[key].sdkSessionId, "sdk-1");
  assert.equal(out?.byChat[key].sessionKey, "sesion-1");
  assert.equal(out?.byChat[key].model, "sonnet");
  assert.equal(out?.activeByProject.general, "c1");
});

test("el turno pendiente se guarda: es lo que permite reengancharse", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1", { pendingTurn: { id: "t-9", seq: 42 } }) });
  assert.deepEqual(out?.byChat[key].pendingTurn, { id: "t-9", seq: 42 });
});

test("el borrador sin enviar se conserva", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1", { draft: "a medio escribir" }) });
  assert.equal(out?.byChat[key].draft, "a medio escribir");
});

test("las imágenes NO se persisten: sus object URLs mueren con la página", () => {
  const key = chatStorageKey("general", "c1");
  const conImg = hilo("c1", {
    messages: [{ id: 1, role: "user", content: "mira", images: [{ url: "blob:x", name: "a.png" }] }],
  });
  const out = ida({ [key]: conImg });
  assert.equal(out?.byChat[key].messages[0].images, undefined);
});

test("un hilo virgen no ocupa cuota", () => {
  const key = chatStorageKey("general", "c1");
  assert.equal(serializeLab({ [key]: hilo("c1", { messages: [], draft: "" }) }, {}, AHORA), null);
});

test("cada chat guarda su propio hilo, incluso del mismo proyecto", () => {
  const kA = chatStorageKey("general", "a");
  const kB = chatStorageKey("general", "b");
  const out = ida({
    [kA]: hilo("a"),
    [kB]: hilo("b", { messages: [{ id: 7, role: "user", content: "solo del chat b" }] }),
  });
  assert.equal(out?.byChat[kA].messages.length, 2);
  assert.equal(out?.byChat[kB].messages[0].content, "solo del chat b");
});

test("archivado se conserva", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1", { archived: true }) });
  assert.equal(out?.byChat[key].archived, true);
});

test("basura guardada no rompe el arranque", () => {
  assert.equal(parseLab("{no es json", AHORA), null);
  assert.equal(parseLab(null, AHORA), null);
  assert.equal(parseLab(JSON.stringify({ v: 99, byChat: {} }), AHORA), null);
  // Esquema v1 (byProject, sin id/archived/updatedAt): se descarta entero, no
  // se intenta migrar — arrancar limpio es aceptable, adivinar no.
  assert.equal(parseLab(JSON.stringify({ v: 1, byProject: { general: hilo("c1") } }), AHORA), null);
});

test("lo guardado hace dos semanas se descarta", () => {
  const key = chatStorageKey("general", "c1");
  const raw = serializeLab({ [key]: hilo("c1") }, {}, AHORA);
  const quinceDias = 15 * 24 * 60 * 60 * 1000;
  assert.equal(parseLab(raw, AHORA + quinceDias), null);
});

test("un hilo con mensajes corruptos se descarta entero, sin tumbar el resto", () => {
  const kMalo = chatStorageKey("general", "malo");
  const kBueno = chatStorageKey("general", "bueno");
  const raw = JSON.stringify({
    v: 2,
    savedAt: AHORA,
    byChat: {
      [kMalo]: {
        id: "malo",
        archived: false,
        updatedAt: AHORA,
        sdkSessionId: null,
        sessionKey: "x",
        messages: [{ nada: true }],
        draft: "",
        model: null,
      },
      [kBueno]: hilo("bueno"),
    },
    activeByProject: {},
  });
  const out = parseLab(raw, AHORA);
  assert.equal(out?.byChat[kMalo], undefined);
  assert.equal(out?.byChat[kBueno].messages.length, 2);
});

test("una conversación enorme se recorta en vez de no guardarse", () => {
  const key = chatStorageKey("general", "c1");
  const gordo = hilo("c1", {
    messages: Array.from({ length: 400 }, (_, i) => ({
      id: i,
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "x".repeat(3000),
    })),
  });
  const out = ida({ [key]: gordo });
  assert.ok(out, "debe guardar algo, no rendirse");
  assert.ok(out!.byChat[key].messages.length <= 60, "recortado a los últimos mensajes");
  // Lo que se conserva es el FINAL de la conversación, que es lo que se lee.
  assert.equal(out!.byChat[key].messages.at(-1)?.id, 399);
});

test("un chat activo no se descarta por cuota aunque sea el más viejo", () => {
  const activeKey = chatStorageKey("general", "viejo-activo");
  const byChat: Record<string, LabThread> = {
    [activeKey]: hilo("viejo-activo", { updatedAt: 0 }),
  };
  // 50 chats más nuevos, por encima del techo de 40.
  for (let i = 0; i < 50; i++) {
    const k = chatStorageKey("general", `nuevo-${i}`);
    byChat[k] = hilo(`nuevo-${i}`, { updatedAt: AHORA + i });
  }
  const out = ida(byChat, { general: "viejo-activo" });
  assert.ok(out?.byChat[activeKey], "el chat activo debe sobrevivir el recorte");
});
