import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLab, parseLab, chatStorageKey, type LabThread } from "./lab-persist";

const AHORA = 1_700_000_000_000;

function hilo(id: string, over: Partial<LabThread> = {}): LabThread {
  return {
    id,
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

// ── Documentos como card (auditoría de Jaime 2026-09-16) ────────────────

test("los documentos SÍ se persisten, a diferencia de las imágenes: no hay object URL que se muera", () => {
  const key = chatStorageKey("general", "c1");
  const conDoc = hilo("c1", {
    messages: [
      { id: 1, role: "user", content: "", docs: [{ name: "informe.pdf", status: "done", chunks: 3, truncated: false }] },
    ],
  });
  const out = ida({ [key]: conDoc });
  assert.deepEqual(out?.byChat[key].messages[0].docs, [
    { name: "informe.pdf", status: "done", chunks: 3, truncated: false },
  ]);
});

test("un documento 'processing' al enviar también se persiste con su estado", () => {
  const key = chatStorageKey("general", "c1");
  const conDoc = hilo("c1", {
    messages: [{ id: 1, role: "user", content: "revisa esto", docs: [{ name: "grande.docx", status: "processing" }] }],
  });
  const out = ida({ [key]: conDoc });
  assert.deepEqual(out?.byChat[key].messages[0].docs, [{ name: "grande.docx", status: "processing" }]);
  assert.equal(out?.byChat[key].messages[0].content, "revisa esto");
});

test("mensaje con imagen Y documentos a la vez: ambos sobreviven, cada uno en su campo", () => {
  const key = chatStorageKey("general", "c1");
  const mixto = hilo("c1", {
    messages: [
      {
        id: 1,
        role: "user",
        content: "mira estos",
        images: [{ url: "blob:x", name: "foto.png" }],
        docs: [
          { name: "a.pdf", status: "done", chunks: 1 },
          { name: "b.xlsx", status: "done", chunks: 2, truncated: true },
        ],
      },
    ],
  });
  const out = ida({ [key]: mixto });
  assert.equal(out?.byChat[key].messages[0].images, undefined);
  assert.equal(out?.byChat[key].messages[0].docs?.length, 2);
  assert.equal(out?.byChat[key].messages[0].docs?.[1].truncated, true);
});

test("un mensaje sin documentos no gana el campo de la nada (undefined, no [])", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1") });
  assert.equal(out?.byChat[key].messages[0].docs, undefined);
});

test("un documento en 'error' (falló DESPUÉS de enviado) se persiste igual — auditoría 2026-09-16", () => {
  const key = chatStorageKey("general", "c1");
  const conError = hilo("c1", {
    messages: [{ id: 1, role: "user", content: "", docs: [{ name: "roto.pdf", status: "error" }] }],
  });
  const out = ida({ [key]: conError });
  assert.deepEqual(out?.byChat[key].messages[0].docs, [{ name: "roto.pdf", status: "error" }]);
});

test("más de MAX_DOCS_PER_MESSAGE documentos: se recorta la lista, no se pierde el mensaje entero", () => {
  const key = chatStorageKey("general", "c1");
  const muchos = hilo("c1", {
    messages: [
      {
        id: 1,
        role: "user",
        content: "",
        docs: Array.from({ length: 50 }, (_, i) => ({ name: `doc-${i}.pdf`, status: "done" as const, chunks: 1 })),
      },
    ],
  });
  const out = ida({ [key]: muchos });
  assert.ok(out, "el mensaje debe sobrevivir, no tirar el localStorage entero");
  assert.ok((out!.byChat[key].messages[0].docs?.length ?? 0) <= 20, "el array de documentos debe quedar acotado");
});

test("un nombre de archivo larguísimo se trunca al persistir", () => {
  const key = chatStorageKey("general", "c1");
  const nombreGigante = "x".repeat(5000) + ".pdf";
  const conNombreLargo = hilo("c1", {
    messages: [{ id: 1, role: "user", content: "", docs: [{ name: nombreGigante, status: "done" }] }],
  });
  const out = ida({ [key]: conNombreLargo });
  const nombreGuardado = out?.byChat[key].messages[0].docs?.[0].name ?? "";
  assert.ok(nombreGuardado.length < nombreGigante.length);
});

test("un 'docs' corrupto (no-array) descarta ESE hilo pero no tumba el resto", () => {
  const kMalo = chatStorageKey("general", "malo");
  const kBueno = chatStorageKey("general", "bueno");
  const raw = JSON.stringify({
    v: 3,
    savedAt: AHORA,
    byChat: {
      [kMalo]: {
        id: "malo",
        updatedAt: AHORA,
        sdkSessionId: null,
        sessionKey: "x",
        messages: [{ id: 1, role: "user", content: "hola", docs: "no-es-un-array" }],
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

test("un documento con 'status' desconocido descarta el hilo, no lo pinta como 'done' a ciegas", () => {
  const key = chatStorageKey("general", "c1");
  const raw = JSON.stringify({
    v: 3,
    savedAt: AHORA,
    byChat: {
      [key]: {
        ...hilo("c1"),
        messages: [{ id: 1, role: "user", content: "", docs: [{ name: "x.pdf", status: "algo-inventado" }] }],
      },
    },
    activeByProject: {},
  });
  const out = parseLab(raw, AHORA);
  assert.equal(out?.byChat[key], undefined);
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

test("basura guardada no rompe el arranque", () => {
  assert.equal(parseLab("{no es json", AHORA), null);
  assert.equal(parseLab(null, AHORA), null);
  assert.equal(parseLab(JSON.stringify({ v: 99, byChat: {} }), AHORA), null);
  // Esquema v1 (byProject, sin id/updatedAt): se descarta entero, no se
  // intenta migrar — arrancar limpio es aceptable, adivinar no.
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
    v: 3,
    savedAt: AHORA,
    byChat: {
      [kMalo]: {
        id: "malo",
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

// Bug real (2026-09-17, gemelo de jaime-os/src/lib/lab-persist.test.ts): un
// guión de clase completo fácil supera los 12.000 caracteres que tenía este
// tope antes, y el corte partía palabras a mitad.
test("un guión largo pero realista (80.000 caracteres) NO se recorta", () => {
  const key = chatStorageKey("general", "c1");
  const guion = "La palabra herramienta aparece muchas veces. ".repeat(1_740); // ~80.5k
  const h = hilo("c1", {
    messages: [{ id: 1, role: "assistant", content: "", blocks: [{ kind: "text", text: guion }] }],
  });
  const out = ida({ [key]: h }, { general: "c1" });
  const bloque = out?.byChat[key].messages[0].blocks?.[0];
  assert.ok(bloque && bloque.kind === "text");
  assert.equal((bloque as { kind: "text"; text: string }).text, guion, "no debió tocarse");
});

test("cuando SÍ hace falta recortar, el corte respeta el borde de palabra (no parte 'herramienta' en 'herr')", () => {
  const key = chatStorageKey("general", "c1");
  const relleno = "x ".repeat(59_998); // 119.996 caracteres
  const texto = `${relleno}herramienta útil para terminar el guión`;
  const h = hilo("c1", {
    messages: [{ id: 1, role: "assistant", content: "", blocks: [{ kind: "text", text: texto }] }],
  });
  const out = ida({ [key]: h }, { general: "c1" });
  const bloque = out?.byChat[key].messages[0].blocks?.[0] as { kind: "text"; text: string };
  assert.match(bloque.text, /recortado/);
  const sinMarcador = bloque.text.replace(/\n\n\[…recortado\]$/, "");
  assert.doesNotMatch(sinMarcador, /herr$/, "no debe cortar 'herramienta' a mitad (bug real reportado)");
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

// ── Papelera (pedido de Jaime 2026-09-16) ────────────────────────────────

test("un chat trashed va y vuelve con su status y trashedAt intactos", () => {
  const key = chatStorageKey("general", "c1");
  const out = ida({ [key]: hilo("c1", { status: "trashed", trashedAt: AHORA }) });
  assert.equal(out?.byChat[key].status, "trashed");
  assert.equal(out?.byChat[key].trashedAt, AHORA);
});

test("un chat trashed SIN mensajes ni draft igual ocupa cuota (worthKeeping)", () => {
  const key = chatStorageKey("general", "c1");
  const raw = serializeLab(
    { [key]: hilo("c1", { messages: [], draft: "", status: "trashed", trashedAt: AHORA }) },
    {},
    AHORA,
  );
  assert.notEqual(raw, null, "un trashed no debe descartarse por estar 'vacío'");
  const out = parseLab(raw, AHORA);
  assert.equal(out?.byChat[key].status, "trashed");
});

test("un trashed de hace 29 días sobrevive; uno de hace 31 se purga solo al hidratar", () => {
  const key29 = chatStorageKey("general", "c29");
  const key31 = chatStorageKey("general", "c31");
  const veintinueveDias = 29 * 24 * 60 * 60 * 1000;
  const treintaYUnDias = 31 * 24 * 60 * 60 * 1000;
  const raw = serializeLab(
    {
      [key29]: hilo("c29", { status: "trashed", trashedAt: AHORA - veintinueveDias }),
      [key31]: hilo("c31", { status: "trashed", trashedAt: AHORA - treintaYUnDias }),
    },
    {},
    AHORA,
  );
  const out = parseLab(raw, AHORA);
  assert.ok(out?.byChat[key29], "29 días: todavía dentro del plazo de 30");
  assert.equal(out?.byChat[key31], undefined, "31 días: ya venció, se descarta al hidratar");
});

test("con cuota apretada, un chat activo desaloja a uno trashed antes que a otro activo", () => {
  const trashedKey = chatStorageKey("general", "trashed-viejo");
  const byChat: Record<string, LabThread> = {
    [trashedKey]: hilo("trashed-viejo", {
      status: "trashed",
      trashedAt: AHORA, // el más "reciente" de todos, pero trashed igual pierde
    }),
  };
  // 40 chats activos genuinos (el techo exacto, MAX_CHATS) más viejos que el
  // trashed en updatedAt — si la papelera compitiera en igualdad de
  // condiciones, alguno de estos perdería su lugar en vez del trashed.
  for (let i = 0; i < 40; i++) {
    const k = chatStorageKey("general", `activo-${i}`);
    byChat[k] = hilo(`activo-${i}`, { updatedAt: AHORA - 1000 + i });
  }
  const out = ida(byChat);
  assert.equal(out?.byChat[trashedKey], undefined, "el trashed debe ser el primero en caer por cuota");
  for (let i = 0; i < 40; i++) {
    assert.ok(out?.byChat[chatStorageKey("general", `activo-${i}`)], `activo-${i} no debió perderse`);
  }
});

test("un trashed con status corrupto pero SIN trashedAt válido no queda inmortal: arranca su cuenta desde ahora", () => {
  // Bug real encontrado en la auditoría 2026-09-16: un JSON viejo/corrupto
  // con `status: "trashed"` pero `trashedAt` ausente (o roto, ej. un string)
  // hacía que `trashedAt` quedara `undefined` para siempre — la condición de
  // purga exige un número, así que NUNCA se cumplía y el chat se quedaba en
  // la papelera de por vida, sin fecha de vencimiento. La corrección: sin
  // una fecha real que confiar, se lo trata como recién eliminado (empieza
  // su propio conteo de 30 días desde `now`), en vez de inmortal.
  const key = chatStorageKey("general", "c1");
  const raw = JSON.stringify({
    v: 3,
    savedAt: AHORA,
    byChat: {
      [key]: { ...hilo("c1"), status: "trashed", trashedAt: "no-es-un-numero" },
    },
    activeByProject: {},
  });
  const out = parseLab(raw, AHORA);
  assert.equal(out?.byChat[key].status, "trashed");
  assert.equal(out?.byChat[key].trashedAt, AHORA, "sin fecha real, arranca el conteo desde 'now'");
  // Y ahora sí purga a los 30 días de ESE arranque, en vez de nunca.
  const treintaYUnDias = 31 * 24 * 60 * 60 * 1000;
  const raw2 = serializeLab(
    { [key]: { ...hilo("c1"), status: "trashed", trashedAt: AHORA } },
    {},
    AHORA,
  );
  const outVencido = parseLab(raw2, AHORA + treintaYUnDias);
  assert.equal(outVencido?.byChat[key], undefined, "con trashedAt saneado, el plazo de 30 días sí corta");
});

test("papelera + turno pendiente: sdkSessionId/sessionKey/pendingTurn sobreviven trashear y restaurar", () => {
  // Ida y vuelta pura (serializeLab/parseLab) de un chat trashed que TENÍA un
  // turno corriendo en el servidor al momento de borrarlo: `restoreChat` en
  // laboratorio/page.tsx solo pela `status`/`trashedAt` del objeto y deja el
  // resto intacto, así que lo que persiste acá es lo que decide si
  // `resumePending` puede reengancharse después de restaurar. Si
  // `sdkSessionId`, `sessionKey` o `pendingTurn` se corrompieran en el viaje,
  // restaurar un chat con un turno vivo dejaría el reenganche roto.
  const key = chatStorageKey("general", "c1");
  const conTurno = hilo("c1", {
    status: "trashed",
    trashedAt: AHORA,
    sdkSessionId: "sdk-en-vuelo",
    sessionKey: "sesion-en-vuelo",
    pendingTurn: { id: "turno-vivo", seq: 7 },
  });
  const out = ida({ [key]: conTurno });
  assert.equal(out?.byChat[key].status, "trashed");
  assert.equal(out?.byChat[key].sdkSessionId, "sdk-en-vuelo");
  assert.equal(out?.byChat[key].sessionKey, "sesion-en-vuelo");
  assert.deepEqual(out?.byChat[key].pendingTurn, { id: "turno-vivo", seq: 7 });
});

test("un chat trashed que además sigue como 'activo por proyecto' nunca se descarta (defensivo)", () => {
  // No debería pasar en la práctica (restaurar/abrir limpia status), pero si
  // pasara, el chat que Samu tiene abierto ahora mismo no puede desaparecer.
  const key = chatStorageKey("general", "raro");
  const byChat: Record<string, LabThread> = {
    [key]: hilo("raro", { status: "trashed", trashedAt: AHORA, updatedAt: 0 }),
  };
  for (let i = 0; i < 50; i++) {
    const k = chatStorageKey("general", `nuevo-${i}`);
    byChat[k] = hilo(`nuevo-${i}`, { updatedAt: AHORA + i });
  }
  const out = ida(byChat, { general: "raro" });
  assert.ok(out?.byChat[key], "el chat activo-por-proyecto sobrevive aunque esté marcado trashed");
});
