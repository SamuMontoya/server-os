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
  turnVisibleTo,
  MAX_ATTEMPTS,
  MAX_CONTINUATIONS,
  CHECKPOINT_INTERVAL_MS,
  type ChatTurn,
  type TurnEvent,
  type TurnRunnerArgs,
  type TurnRunnerResult,
} from "./chat-turns.js";
import { routeTurn } from "./router.js";

/** Motor con reloj y esperas de mentira; `run` lo define cada test. */
function engineWith(run: (args: TurnRunnerArgs, attempt: number) => Promise<TurnRunnerResult>) {
  let attempt = 0;
  const slept: number[] = [];
  const persisted: { prompt: string; text: string; status: string }[] = [];
  const checkpoints: { text: string; sdkSessionId?: string }[] = [];
  const clearedCheckpoints: string[] = [];
  let clock = 1_000;
  const engine = createTurnEngine({
    run: (args) => run(args, ++attempt),
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => clock,
    persist: (t) => persisted.push({ prompt: t.prompt, text: t.text, status: t.status }),
    checkpoint: (t) => checkpoints.push({ text: t.text, sdkSessionId: t.sdkSessionId }),
    clearCheckpoint: (id) => clearedCheckpoints.push(id),
  });
  return {
    engine,
    slept,
    persisted,
    checkpoints,
    clearedCheckpoints,
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
  const turn = h.engine.start({ prompt: "bucle", sessionKey: "tab-2-no-converge" });
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "error");
  // 1 intento original + MAX_CONTINUATIONS continuaciones.
  assert.equal(h.attempts(), 1 + MAX_CONTINUATIONS);
  // El mensaje final es en español y accionable, no el string crudo que el
  // SDK arma para su propia excepción interna (lo que `finalText` traía acá).
  assert.match(snap.error ?? "", /presupuesto de turnos/i);
  assert.doesNotMatch(snap.error ?? "", /sigo sin acabar/);
});

test("error_max_turns SUBE de nivel la sesión al continuar, no repite el mismo techo", async () => {
  // El bug real: una pregunta de estado ("dame el estado de X") sin más señal
  // cae en trivial/haiku (maxTurns:6, ver TIERS en router.ts) pero puede
  // resultar una investigación de 19 pasos. Antes la auto-continuación
  // reusaba el MISMO nivel pinneado, así que solo compraba 6 turnos más y
  // volvía a chocar. Ahora escala la sesión un nivel antes de continuar.
  const sessionKey = `tab-escala-${Date.now()}`;
  const h = engineWith(async (args) => {
    args.onSession("sdk-viva");
    return { finalText: "", isError: true, errorSubtype: "error_max_turns" };
  });
  // Fija la sesión en trivial (como haría el router real al clasificar una
  // pregunta de estado sin más señal).
  const before = routeTurn("dame el estado de x", sessionKey);
  assert.equal(before.tier, "trivial");
  h.engine.start({ prompt: "dame el estado de x", sessionKey });
  await settle();
  await settle();
  await settle();
  await settle();
  // MAX_CONTINUATIONS=2: dos escaladas de un nivel cada una → trivial→bajo→medio.
  const after = routeTurn("cualquier cosa", sessionKey);
  assert.equal(after.tier, "medio", "la sesión debe subir un nivel por cada continuación");
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

test("turnVisibleTo: solo choca cuando AMBOS lados tienen userId y no coinciden", () => {
  const turnDe = (userId?: string): ChatTurn => ({
    id: "t1",
    sessionKey: "tab-1",
    project: "general",
    prompt: "p",
    status: "done",
    text: "hola",
    steps: [],
    files: [],
    attempts: 1,
    startedAt: 0,
    ...(userId ? { userId } : {}),
  });
  // Turno sin dueño (HERMES_API_KEY estática / reloj): visible para todos.
  assert.equal(turnVisibleTo(turnDe(undefined), "user-a"), true);
  assert.equal(turnVisibleTo(turnDe(undefined), undefined), true);
  // Requester sin userId (misma key estática): full trust, ve cualquier turno.
  assert.equal(turnVisibleTo(turnDe("user-a"), undefined), true);
  // Mismo dueño: visible.
  assert.equal(turnVisibleTo(turnDe("user-a"), "user-a"), true);
  // Dueños distintos: el único caso que se niega.
  assert.equal(turnVisibleTo(turnDe("user-a"), "user-b"), false);
});

test("start() guarda el userId del requester en el turno", async () => {
  const h = engineWith(ok("hola"));
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1", userId: "user-a" });
  assert.equal(turn.userId, "user-a");
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.userId, "user-a");
  const anonimo = h.engine.start({ prompt: "p", sessionKey: "tab-2" });
  assert.equal(anonimo.userId, undefined);
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

test("la PROSA del modelo no se juzga como error transitorio", async () => {
  // Regresión de costo. `isRetryable()` hace match de subcadenas ("timeout",
  // "500", "network"…) y antes se le pasaba `result.finalText`, o sea el texto
  // del MODELO. Hermes es un asistente técnico que habla de códigos HTTP a
  // diario, así que una respuesta perfectamente normal como la de abajo se
  // leía como un fallo de red y RE-EJECUTABA el mensaje entero 3 veces.
  //
  // El guardia `partial` no cubría esto: solo mira si llegaron deltas, y el
  // SDK puede cerrar con el texto final sin haber mandado ninguno — que es
  // exactamente lo que simula este handler.
  const h = engineWith(async () => ({
    finalText: "Revisé el endpoint y devolvió 500 con un timeout de red.",
    isError: true,
    errorSubtype: "error_during_execution",
  }));
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  const snap = h.engine.snapshot(turn.id)!;
  assert.equal(snap.status, "error");
  assert.equal(h.attempts(), 1, "no debe reintentar por lo que DICE el modelo");
});

test("un error de API sí se reintenta aunque el texto no suene a red", async () => {
  // El espejo del test anterior: la señal buena es `errorSubtype`, no el texto.
  const h = engineWith(async (args, attempt) => {
    if (attempt === 1) {
      return { finalText: "algo salió mal", isError: true, errorSubtype: "api_error" };
    }
    args.onDelta("ok");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.status, "done");
  assert.equal(h.attempts(), 2);
});

test("el motor le pasa al runner la clave del HILO (fija el nivel del router)", async () => {
  // Regresión de costo Y de calidad. El nivel del router se fija por hilo, y
  // antes se usaba como clave el id de sesión del SDK — que en el PRIMER turno
  // todavía no existe (lo devuelve el SDK en su init). Resultado: el primer
  // mensaje no fijaba nada y el nivel de toda la conversación lo decidía el
  // SEGUNDO. Un "Arregla el bug del login" seguido de un "gracias" clavaba un
  // hilo de código entero en haiku.
  //
  // La clave correcta es `sessionKey` (la pestaña del chat): existe desde el
  // primer mensaje y dura toda la conversación. Este test vigila que llegue
  // hasta el runner — el salto donde ya se perdió `maxTier` una vez, porque el
  // adaptador de producción copia campo a campo en vez de hacer spread.
  const vistos: (string | undefined)[] = [];
  const h = engineWith(async (args) => {
    vistos.push(args.sessionKey);
    args.onDelta("ok");
    return { finalText: "", isError: false };
  });
  h.engine.start({ prompt: "Arregla el bug del login", sessionKey: "tab-uuid-1" });
  await settle();
  assert.deepEqual(vistos, ["tab-uuid-1"]);
});

test("las auto-continuaciones NO repiten la búsqueda semántica del turno", async () => {
  // La continuación manda CONTINUE_PROMPT, un "sigue" sintético. Buscar
  // conocimiento semántico con ese texto devuelve ruido y se paga igual (el
  // contexto que hacía falta ya está en el historial de la sesión que se
  // continúa), así que la precarga se apaga a partir de la primera.
  const flags: (boolean | undefined)[] = [];
  const h = engineWith(async (args, attempt) => {
    flags.push(args.precargarContexto);
    if (attempt === 1) {
      args.onSession("sdk-1");
      return { finalText: "", isError: true, errorSubtype: "error_max_turns" };
    }
    args.onDelta("listo");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "haz la tarea larga", sessionKey: "tab-1" });
  await settle();
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.status, "done");
  assert.deepEqual(flags, [true, false], "el turno real precarga; la continuación no");
});

// ── Checkpoint (sobrevivir un reinicio del agente a mitad de turno) ─────

test("onSession dispara un checkpoint INMEDIATO, sin esperar al throttle", async () => {
  const h = engineWith(async (args) => {
    args.onSession("sdk-1");
    args.onDelta("hola");
    return { finalText: "", isError: false };
  });
  h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  // El primer checkpoint (el de onSession) ya debe existir con el sdkSessionId,
  // aunque no haya pasado ni un ms de reloj.
  assert.ok(h.checkpoints.length >= 1);
  assert.equal(h.checkpoints[0].sdkSessionId, "sdk-1");
});

test("los deltas siguientes NO re-checkpointean hasta que pasa el intervalo", async () => {
  const h = engineWith(async (args) => {
    args.onSession("sdk-1");
    args.onDelta("a"); // checkpoint por onSession ya cuenta como "reciente"
    args.onDelta("b"); // sin avanzar el reloj: no debe sumar otro checkpoint
    args.onDelta("c");
    return { finalText: "", isError: false };
  });
  h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  // Solo el de onSession: los tres deltas corrieron en el mismo instante.
  assert.equal(h.checkpoints.length, 1);
});

test("pasado CHECKPOINT_INTERVAL_MS, el siguiente delta SÍ checkpointea de nuevo", async () => {
  const h = engineWith(async (args) => {
    args.onSession("sdk-1");
    args.onDelta("primero");
    h.advance(CHECKPOINT_INTERVAL_MS + 1);
    args.onDelta("segundo");
    return { finalText: "", isError: false };
  });
  h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  // onSession + el delta que cae después de que venció el throttle.
  assert.equal(h.checkpoints.length, 2);
  assert.equal(h.checkpoints[1].text, "primerosegundo");
});

test("al cerrar (done/error/stopped) se limpia el checkpoint", async () => {
  const h = engineWith(async (args) => {
    args.onSession("sdk-1");
    args.onDelta("hola");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.status, "done");
  assert.deepEqual(h.clearedCheckpoints, [turn.id]);
});

test("un turno detenido (⏹) también limpia su checkpoint", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const h = engineWith(async (args) => {
    args.onSession("sdk-1");
    args.onDelta("a medias");
    await gate;
    // El SDK real lanza al abortar; imitamos eso (ver el test de arriba).
    if (args.abortController.signal.aborted) throw new Error("aborted");
    return { finalText: "", isError: false };
  });
  const turn = h.engine.start({ prompt: "p", sessionKey: "tab-1" });
  await settle();
  h.engine.stop(turn.id);
  release!();
  await settle();
  await settle();
  assert.equal(h.engine.snapshot(turn.id)!.status, "stopped");
  assert.deepEqual(h.clearedCheckpoints, [turn.id]);
});
