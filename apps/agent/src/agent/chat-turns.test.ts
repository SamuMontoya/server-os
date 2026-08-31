/**
 * Tests del motor de turnos. Corren con `node:test` sobre tsx — sin SDK, sin
 * red y sin esperas reales: el motor recibe `run`, `sleep` y `now` inyectados.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTurnEngine,
  isRetryable,
  MAX_ATTEMPTS,
  MAX_CONTINUATIONS,
  type TurnEvent,
  type TurnRunnerArgs,
  type TurnRunnerResult,
} from "./chat-turns.js";

/** Motor con reloj y esperas de mentira; `run` lo define cada test. */
function engineWith(run: (args: TurnRunnerArgs, attempt: number) => Promise<TurnRunnerResult>) {
  let attempt = 0;
  const slept: number[] = [];
  const persisted: { prompt: string; text: string; status: string }[] = [];
  let clock = 1_000;
  const engine = createTurnEngine({
    run: (args) => run(args, ++attempt),
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => clock,
    persist: (t) => persisted.push({ prompt: t.prompt, text: t.text, status: t.status }),
  });
  return {
    engine,
    slept,
    persisted,
    attempts: () => attempt,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** El motor arranca el turno en segundo plano: hay que dejar correr el loop. */
const settle = () => new Promise((r) => setImmediate(r));

const ok = (text: string) => async (args: TurnRunnerArgs) => {
  args.onSession("sdk-1");
  for (const ch of text.split(" ")) args.onDelta(ch + " ");
  return { sdkSessionId: "sdk-1", finalText: text, isError: false };
};

test("el turno entrega su texto y queda done", async () => {
  const h = engineWith(ok("hola mundo"));
  const turn = h.engine.start({ prompt: "hola", sessionKey: "tab-1" });
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "done");
  assert.equal(snap.text.trim(), "hola mundo");
  assert.equal(snap.attempts, 1);
  assert.equal(snap.sdkSessionId, "sdk-1");
  assert.deepEqual(h.persisted, [{ prompt: "hola", text: "hola mundo ", status: "done" }]);
});

test("irse NO cancela el turno: al volver, el texto completo está ahí", async () => {
  // El cliente se suscribe, recibe un delta y se desengancha (pantalla
  // bloqueada). El turno tiene que seguir hasta el final igual.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const h = engineWith(async (args) => {
    args.onDelta("primera parte ");
    await gate;
    args.onDelta("segunda parte");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  const live: TurnEvent[] = [];
  const att = h.engine.attach(turn.id, 0, (e) => live.push(e))!;
  await settle();
  att.unsubscribe(); // el cliente desaparece a mitad del turno
  const seen = att.snapshot.events.concat(live);
  release!();
  await settle();
  await settle();

  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "done", "seguir sin cliente no debe abortar");
  assert.equal(snap.text, "primera parte segunda parte");
  // Y quien vuelve pide desde su cursor y recibe SOLO lo que le falta.
  const resumed = h.engine.snapshot(turn.id, seen[seen.length - 1].seq)!;
  assert.equal(
    resumed.events.filter((e) => e.kind === "delta").map((e) => e.text).join(""),
    "segunda parte",
  );
});

test("re-adjuntarse desde un cursor no pierde ni duplica deltas", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const h = engineWith(async (args) => {
    args.onDelta("a");
    args.onDelta("b");
    await gate;
    args.onDelta("c");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  const live: TurnEvent[] = [];
  // Suscribirse SIEMPRE llega tarde (start y el stream son dos requests): los
  // primeros deltas ya se emitieron y solo el replay del buffer los tiene.
  const att1 = h.engine.attach(turn.id, 0, (e) => live.push(e))!;
  assert.ok(att1.snapshot.events.length > 0, "el snapshot trae lo emitido antes del attach");
  await settle();
  att1.unsubscribe();

  const first = att1.snapshot.events.concat(live);
  const cursor = first[first.length - 1].seq;

  const second: TurnEvent[] = [];
  const att2 = h.engine.attach(turn.id, cursor, (e) => second.push(e))!;
  release!();
  await settle();
  await settle();

  const replayed = att2.snapshot.events.concat(second);
  const text = replayed.filter((e) => e.kind === "delta").map((e) => e.text).join("");
  assert.equal(text, "c", "el replay arranca justo después del cursor");
  const all = first.concat(replayed).filter((e) => e.kind === "delta");
  assert.equal(all.map((e) => e.text).join(""), "abc");
  // Cursores estrictamente crecientes y sin repetidos.
  const seqs = first.concat(replayed).map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b));
});

test("un fallo transitorio se reintenta hasta 3 veces y sale bien", async () => {
  const h = engineWith(async (args, attempt) => {
    if (attempt < 3) throw new Error("fetch failed: ECONNRESET");
    args.onDelta("listo");
    return { finalText: "listo", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "done");
  assert.equal(snap.attempts, 3);
  assert.equal(snap.text, "listo", "el reintento no acumula texto de intentos muertos");
  assert.deepEqual(h.slept, [1000, 3000], "backoff creciente");
  const retries = snap.events.filter((e) => e.kind === "retry");
  assert.deepEqual(
    retries.map((e) => e.attempt),
    [2, 3],
    "cada reintento se anuncia: el cliente puede decir 'reintentando (2/3)'",
  );
});

test("agotados los 3 intentos, ahí sí reporta el error", async () => {
  const h = engineWith(async () => {
    throw new Error("503 service unavailable");
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  for (let i = 0; i < 6; i++) await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "error");
  assert.equal(snap.attempts, MAX_ATTEMPTS);
  assert.match(snap.error ?? "", /503/);
  assert.equal(h.persisted.length, 0, "un turno sin texto no ensucia el historial");
});

test("un error de contenido NO se reintenta (no triplica el gasto)", async () => {
  const h = engineWith(async () => ({
    finalText: "no encontré ese archivo en el repo",
    isError: true,
  }));
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  assert.equal(h.attempts(), 1);
  assert.equal(h.engine.snapshot(turn.id)!.status, "error");
  assert.deepEqual(h.slept, []);
});

test("con texto ya entregado no se reintenta: repetiría media respuesta", async () => {
  const h = engineWith(async (args) => {
    args.onDelta("iba escribiendo…");
    throw new Error("ECONNRESET");
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  assert.equal(h.attempts(), 1);
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "error");
  assert.equal(snap.text, "iba escribiendo…", "lo ya escrito se conserva");
  assert.equal(h.persisted.length, 1, "y se guarda: el usuario lo vio");
});

test("el reintento CONTINÚA la sesión del SDK, no abre una nueva", async () => {
  const resumes: (string | undefined)[] = [];
  const h = engineWith(async (args, attempt) => {
    resumes.push(args.resumeSessionId);
    if (attempt === 1) {
      args.onSession("sdk-nacida");
      throw new Error("socket hang up");
    }
    return { finalText: "ok", isError: false };
  });
  h.engine.start({ prompt: "p", sessionKey: "tab-1", resumeSessionId: undefined });
  await settle();
  await settle();
  assert.deepEqual(resumes, [undefined, "sdk-nacida"]);
});

test("error_max_turns se auto-continúa: no obliga a escribir 'continúa'", async () => {
  // Este es EL caso que sacaba el ⚠ y dejaba el trabajo a medias. El SDK cierra
  // con subtype error_max_turns (se acabó maxTurns), pero la sesión sigue viva:
  // el motor debe pedirle que siga solo, en la MISMA sesión, y pegar el texto
  // nuevo debajo del que ya había — sin repetirlo.
  const prompts: string[] = [];
  const resumes: (string | undefined)[] = [];
  const h = engineWith(async (args, attempt) => {
    prompts.push(args.prompt);
    resumes.push(args.resumeSessionId);
    if (attempt === 1) {
      args.onSession("sdk-viva");
      args.onDelta("voy a medias…");
      return { finalText: "voy a medias…", isError: true, errorSubtype: "error_max_turns" };
    }
    args.onDelta(" y ya terminé");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "haz algo largo", sessionKey: "tab-1" });
  await settle();
  await settle();

  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "done", "continuar solo debe terminar en done, no en error");
  assert.equal(snap.text, "voy a medias… y ya terminé", "el texto se acumula, no se repite");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "haz algo largo");
  assert.match(prompts[1], /Continúa EXACTAMENTE donde te quedaste/);
  assert.deepEqual(resumes, [undefined, "sdk-viva"], "continúa la misma sesión del SDK");
  // El cliente se entera de que está continuando (evento retry), en vez de
  // ver un turno mudo.
  const kinds = snap.events.map((e) => e.kind);
  assert.ok(kinds.includes("retry"), "se avisa que está continuando");
});

test("una continuación que no converge acaba cerrando en error, no en bucle", async () => {
  // Tope de seguridad: si el agente se queda sin turnos una y otra vez, esto
  // no puede reintentar para siempre (sería gasto infinito).
  const h = engineWith(async (args) => {
    args.onSession("sdk-viva");
    return { finalText: "sigo sin acabar", isError: true, errorSubtype: "error_max_turns" };
  });
  const turn = h.engine.start({ prompt: "bucle", sessionKey: "tab-1" });
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "error");
  // 1 intento original + MAX_CONTINUATIONS continuaciones.
  assert.equal(h.attempts(), 1 + MAX_CONTINUATIONS);
});

test("un 429 servido como 'success' con is_error se trata como error real", async () => {
  // El SDK a veces entrega el error de la API COMO SI fuera la respuesta
  // (subtype success + is_error). session.ts lo marca como api_error; aquí se
  // comprueba que el motor lo reintenta como el transitorio que es.
  const h = engineWith(async (args, attempt) => {
    if (attempt === 1) {
      return {
        finalText: "API Error: 529 overloaded_error",
        isError: true,
        errorSubtype: "api_error",
      };
    }
    args.onDelta("ahora sí");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "done");
  assert.equal(snap.text, "ahora sí");
  assert.equal(h.attempts(), 2);
});

test("⏹ Detener es cancelación explícita, no un error", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const h = engineWith(async (args) => {
    args.onDelta("empezando");
    await gate;
    // El SDK real lanza al abortar; imitamos eso.
    if (args.abortController.signal.aborted) throw new Error("aborted");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  assert.equal(h.engine.stop(turn.id), true);
  release!();
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "stopped");
  assert.equal(h.attempts(), 1, "un stop no dispara reintentos");
  assert.equal(h.persisted.length, 0, "lo cancelado no entra al historial");
});

test("detener un turno ya cerrado no hace nada", async () => {
  const h = engineWith(ok("ya"));
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  assert.equal(h.engine.stop(turn.id), false);
  assert.equal(h.engine.stop("no-existe"), false);
});

test("listBySession devuelve los turnos del tab, del más nuevo al más viejo", async () => {
  const h = engineWith(ok("x"));
  const a = h.engine.start({ prompt: "1", sessionKey: "tab-1" });
  await settle();
  h.advance(10);
  const b = h.engine.start({ prompt: "2", sessionKey: "tab-1" });
  await settle();
  h.advance(10);
  h.engine.start({ prompt: "3", sessionKey: "tab-2" });
  await settle();
  const mine = h.engine.listBySession("tab-1");
  assert.deepEqual(mine.map((t) => t.id), [b.id, a.id]);
});

test("los turnos viejos se sueltan; los vivos nunca", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const h = engineWith(async (args, attempt) => {
    if (attempt === 1) {
      await gate; // este queda corriendo mientras pasa el tiempo
      return { finalText: "", isError: false };
    }
    return ok("x")(args);
  });
  const vivo = h.engine.start({ prompt: "vivo", sessionKey: "tab-1" });
  await settle();
  const viejo = h.engine.start({ prompt: "viejo", sessionKey: "tab-1" });
  await settle();
  h.advance(7 * 60 * 60 * 1000); // más que la retención
  h.engine.start({ prompt: "nuevo", sessionKey: "tab-1" }); // dispara el evict
  await settle();
  assert.ok(h.engine.get(vivo.id), "un turno corriendo no se puede soltar");
  assert.equal(h.engine.get(viejo.id), undefined);
  release!();
});

test("truncated avisa cuando el buffer ya botó lo que el cliente pide", async () => {
  const h = engineWith(async (args) => {
    for (let i = 0; i < 2100; i++) args.onDelta("x");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  const snap = h.engine.snapshot(turn.id, 5)!;
  assert.equal(snap.truncated, true);
  assert.equal(snap.text.length, 2100, "el texto íntegro sobrevive al recorte");
  // Sin hueco (pide desde el principio o desde el final) no se marca.
  assert.equal(h.engine.snapshot(turn.id, 0)!.truncated, false);
});

test("isRetryable separa lo transitorio de lo que no lo es", () => {
  for (const m of ["fetch failed", "ECONNRESET", "HTTP 529", "Overloaded", "rate limit exceeded"])
    assert.equal(isRetryable(m), true, m);
  for (const m of ["no encontré el archivo", "permiso denegado por el usuario", "prompt vacío"])
    assert.equal(isRetryable(m), false, m);
});

test("un suscriptor que revienta no tumba el turno ni a los demás", async () => {
  const h = engineWith(ok("hola mundo"));
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  const sano: TurnEvent[] = [];
  h.engine.attach(turn.id, 0, () => {
    throw new Error("cliente roto");
  });
  h.engine.attach(turn.id, 0, (e) => sano.push(e));
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.status, "done");
  assert.ok(sano.length > 0);
});
