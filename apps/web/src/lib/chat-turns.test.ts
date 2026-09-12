/**
 * Tests de `attachTurn` (reenganche del stream de un turno): pnpm --filter
 * @hermes/web test
 *
 * Motivación: Samu reportó que al cambiar de chat, salir de la app o apagar
 * la pantalla y volver, el stream "se queda pegado" (sin ícono de detener
 * moviéndose). No se pudo reproducir en vivo en el navegador real (pide login
 * de Google). Estos tests ejercitan la lógica REAL de `attachTurn` (mockeando
 * `EventSource`/`document`, sin jsdom) para las tres situaciones que describió:
 * conexión que se queda muda (watchdog), volver de segundo plano
 * (visibilitychange), y que el cursor de reenganche no pierda ni duplique
 * eventos.
 *
 * OJO al escribir tests nuevos acá: `attachTurn` deja un `setInterval` (el
 * watchdog) vivo hasta que se llama la función que devuelve o hasta que el
 * turno cierra solo (`done`/`error`/`stopped`). Un test que no lo llame dejó
 * el proceso de Node colgado esperando ese interval para siempre (encontrado
 * en la primera versión de este archivo) — todo test que no llegue a `done`
 * DEBE llamar `unsub()` al final, en un `finally`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { attachTurn } from "./chat-turns.js";

// ── Mocks de entorno de navegador ───────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<(ev: { data: string }) => void>>();
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  close(): void {
    this.closed = true;
  }
  /** Simula un evento del servidor. */
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
  error(): void {
    this.onerror?.();
  }
}

class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
}

function setupEnv(): { doc: FakeDocument } {
  FakeEventSource.instances.length = 0;
  const doc = new FakeDocument();
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { doc };
}

function lastEs(): FakeEventSource {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert.ok(es, "se esperaba una FakeEventSource creada");
  return es;
}

// ── Tests ────────────────────────────────────────────────────────────────

test("attachTurn: procesa state + deltas + done, y limpia todo al cerrar", () => {
  const { doc } = setupEnv();
  const deltas: string[] = [];
  const ends: string[] = [];
  const unsub = attachTurn("t1", 0, {
    onState: () => {},
    onDelta: (t) => deltas.push(t),
    onEnd: (status) => ends.push(status),
  });

  const es = lastEs();
  assert.match(es.url, /\/chat\/turns\/t1\/stream\?from=0/);

  es.emit("turn", { seq: 1, kind: "delta", text: "Hola " });
  es.emit("turn", { seq: 2, kind: "delta", text: "mundo" });
  es.emit("turn", { seq: 3, kind: "done" });

  assert.deepEqual(deltas, ["Hola ", "mundo"]);
  assert.deepEqual(ends, ["done"]);
  assert.equal(es.closed, true, "el EventSource debe cerrarse al terminar el turno");
  assert.equal(
    doc.listenerCount("visibilitychange"),
    0,
    "no debe quedar el listener de visibilitychange colgado tras done",
  );

  unsub(); // ya cerrado por "done"; no debería tirar ni reabrir nada
});

test("attachTurn: un evento con seq <= al cursor actual se ignora (no duplica)", () => {
  setupEnv();
  const deltas: string[] = [];
  const unsub = attachTurn("t2", 5, { onDelta: (t) => deltas.push(t) });
  try {
    const es = lastEs();
    // seq=5 y seq=3 son <= from=5: deben ignorarse (replay repetido).
    es.emit("turn", { seq: 5, kind: "delta", text: "viejo" });
    es.emit("turn", { seq: 3, kind: "delta", text: "más viejo" });
    es.emit("turn", { seq: 6, kind: "delta", text: "nuevo" });

    assert.deepEqual(deltas, ["nuevo"]);
  } finally {
    unsub();
  }
});

test("attachTurn: conexión muda por más de STALE_MS dispara reconexión (watchdog)", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let unsub: (() => void) | undefined;
  try {
    setupEnv();
    unsub = attachTurn("t3", 0, {});
    const first = lastEs();
    assert.equal(FakeEventSource.instances.length, 1);

    // Sin ningún byte (ni delta ni ping) durante más de STALE_MS (45s): el
    // watchdog (revisa cada WATCHDOG_MS=5s) debe reabrir la conexión.
    mock.timers.tick(46_000);

    assert.equal(first.closed, true, "la conexión vieja debe cerrarse");
    assert.equal(
      FakeEventSource.instances.length,
      2,
      "debe haberse abierto una FakeEventSource nueva",
    );
  } finally {
    unsub?.();
    mock.timers.reset();
  }
});

test("attachTurn: un ping mantiene la conexión viva (el watchdog NO reconecta)", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let unsub: (() => void) | undefined;
  try {
    setupEnv();
    unsub = attachTurn("t4", 0, {});
    const es = lastEs();

    // A los 40s (antes de STALE_MS) llega un latido: refresca `lastBeat`.
    mock.timers.tick(40_000);
    es.emit("ping", { t: Date.now() });
    // Otros 40s más (80s totales, pero solo 40s desde el último latido):
    // NO debería haber reconectado, porque nunca pasaron los 45s de silencio.
    mock.timers.tick(40_000);

    assert.equal(es.closed, false, "no debía cerrarse: el ping renovó el latido");
    assert.equal(FakeEventSource.instances.length, 1);
  } finally {
    unsub?.();
    mock.timers.reset();
  }
});

test("attachTurn: volver de segundo plano con conexión vieja (>RESUME_STALE_MS) reengancha YA, sin esperar el watchdog", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let unsub: (() => void) | undefined;
  try {
    const { doc } = setupEnv();
    doc.visibilityState = "hidden";
    unsub = attachTurn("t5", 0, {});
    const first = lastEs();

    // 10s en segundo plano (> RESUME_STALE_MS=8s, pero << STALE_MS=45s: el
    // watchdog por sí solo NO habría reconectado todavía).
    mock.timers.tick(10_000);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");

    assert.equal(first.closed, true, "la vuelta a primer plano debe reenganchar de una");
    assert.equal(FakeEventSource.instances.length, 2);
  } finally {
    unsub?.();
    mock.timers.reset();
  }
});

test("attachTurn: volver de segundo plano con conexión RECIÉN usada no reconecta de más", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let unsub: (() => void) | undefined;
  try {
    const { doc } = setupEnv();
    unsub = attachTurn("t6", 0, {});
    const es = lastEs();

    doc.visibilityState = "hidden";
    mock.timers.tick(2_000); // menos que RESUME_STALE_MS=8s
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");

    assert.equal(es.closed, false, "2s de silencio no amerita reconectar");
    assert.equal(FakeEventSource.instances.length, 1);
  } finally {
    unsub?.();
    mock.timers.reset();
  }
});

test("attachTurn: la reconexión pide el stream desde el ÚLTIMO seq visto (no repite desde 0)", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let unsub: (() => void) | undefined;
  try {
    setupEnv();
    const deltas: string[] = [];
    unsub = attachTurn("t7", 0, { onDelta: (t) => deltas.push(t) });
    const first = lastEs();
    first.emit("turn", { seq: 1, kind: "delta", text: "a" });
    first.emit("turn", { seq: 2, kind: "delta", text: "b" });

    mock.timers.tick(46_000); // fuerza reconexión por watchdog
    const second = lastEs();
    assert.match(
      second.url,
      /from=2/,
      `la reconexión debe pedir from=2 (último seq visto), url fue: ${second.url}`,
    );

    second.emit("turn", { seq: 3, kind: "delta", text: "c" });
    assert.deepEqual(deltas, ["a", "b", "c"], "sin huecos ni duplicados tras reconectar");
  } finally {
    unsub?.();
    mock.timers.reset();
  }
});
