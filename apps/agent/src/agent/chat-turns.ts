/**
 * Turnos del chat como TRABAJOS DEL SERVIDOR, no como cuerpo de un request.
 *
 * El problema que resuelve: `/v1/chat/completions` corría el turno DENTRO del
 * request y transmitía por el mismo socket. Cuando el cliente se va —el iPhone
 * bloquea la pantalla y iOS congela la pestaña, se cambia de app, se cae el
 * WiFi— el cliente ve un error y la respuesta ya nunca llega a la pantalla,
 * aunque el agente la haya terminado. Y al reabrir, el hilo aparecía vacío.
 *
 * Aquí el turno vive en el servidor con su propio buffer de eventos numerados
 * (mismo patrón que las runs de claude-cli.ts, que sí aguantan). El cliente
 * arranca el turno, se suscribe, se puede ir, y al volver:
 *   - si terminó → `GET /chat/turns/:id` le da el texto COMPLETO;
 *   - si sigue → se re-adjunta con `?from=<seq>` y no pierde un solo delta.
 *
 * Irse NO cancela nada. Cancelar es un acto explícito (`stopTurn`).
 *
 * El motor se construye con sus dependencias inyectadas (`createTurnEngine`)
 * para poder testear reintentos, replay y cancelación sin SDK ni red.
 */
import { randomUUID } from "node:crypto";
import { escalateSession, nextTier, routeTurn, type Tier } from "./router.js";
import type { ChatToolStep } from "@hermes/shared";
import { runAgentTurn, saveSdkSession } from "./session.js";
import { appendTurn } from "../conversations.js";
import { attachmentNote } from "../chat-attachments.js";
import { checkpointTurn, clearCheckpoint } from "../chat-turn-checkpoints.js";
import { env } from "../env.js";

// ── Eventos ────────────────────────────────────────────────────────────
export type TurnEventKind =
  | "session" // el SDK anunció su session id (el tab lo adopta para resumir)
  | "model" // el router eligió modelo (y puede volver a emitirse al escalar)
  | "delta" // texto
  | "tool" // paso agéntico
  | "retry" // se cayó y se está reintentando (el cliente lo puede decir)
  | "done"
  | "error"
  | "stopped";

export interface TurnEvent {
  /** Monotónico por turno y desde 1: es el cursor del replay. */
  seq: number;
  kind: TurnEventKind;
  text?: string;
  tool?: ChatToolStep;
  sessionId?: string;
  /** En `model`: alias del modelo ("sonnet"|"haiku") y su esfuerzo. */
  model?: string;
  effort?: string;
  /** En `retry`: qué intento viene ahora (2 = el segundo). */
  attempt?: number;
}

export type TurnStatus = "running" | "done" | "error" | "stopped";

export interface ChatTurn {
  id: string;
  /** Clave del tab que lo disparó (X-Hermes-Session-Id). */
  sessionKey: string;
  project: string;
  prompt: string;
  /**
   * Dueño del turno: el `userId` que el middleware de index.ts resolvió del
   * JWT de Supabase (ver auth.ts). Ausente cuando el turno lo disparó la
   * HERMES_API_KEY estática (LAN/reloj, sin login) — esos turnos no tienen
   * dueño y quedan visibles para cualquiera, como siempre. Ver `turnVisibleTo`.
   */
  userId?: string;
  /**
   * Rutas absolutas de las imágenes adjuntas. Viven en el turno (no solo en el
   * input) porque el motor reintenta hasta 3 veces: cada intento tiene que
   * volver a mandar los mismos adjuntos, o el reintento perdería la imagen y
   * respondería a ciegas sobre el texto pelado.
   */
  attachments?: string[];
  status: TurnStatus;
  /** Texto acumulado ÍNTEGRO — no se recorta nunca; es lo que ve quien vuelve. */
  text: string;
  steps: ChatToolStep[];
  sdkSessionId?: string;
  /**
   * Modelo con el que corre/corrió el turno. Vive en el turno (no solo en el
   * evento) para que quien se engancha tarde lo sepa por el snapshot, sin
   * depender de un evento que el buffer ya pudo botar.
   */
  model?: string;
  effort?: string;
  /** Intentos consumidos (1 = salió a la primera). */
  attempts: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Lo que se manda por el cable: el turno + los eventos que el cliente no vio. */
export interface TurnSnapshot extends ChatTurn {
  events: TurnEvent[];
  /** seq del último evento emitido (el cursor a pedir la próxima vez). */
  seq: number;
  /**
   * true si el buffer ya botó eventos anteriores a `from`. El cliente no
   * pierde nada: `text` viene completo y debe repintar con él en vez de ir
   * concatenando deltas.
   */
  truncated: boolean;
}

// ── Límites ────────────────────────────────────────────────────────────
/** Eventos vivos por turno. Al pasarse se botan los viejos; `text` sobrevive. */
const MAX_EVENTS = 2000;
/** Turnos retenidos en memoria (los viejos siguen en el historial en disco). */
const MAX_TURNS = 60;
/** Un turno terminado se retiene esto para quien vuelva tarde. */
const RETAIN_MS = 6 * 60 * 60 * 1000;
/** Intentos totales antes de reportar el error. */
export const MAX_ATTEMPTS = 3;
/** Espera antes de cada reintento (determinista: los tests la controlan). */
const BACKOFF_MS = [1000, 3000];

/**
 * Auto-continuación cuando el SDK cierra un turno por `error_max_turns`: el
 * trabajo quedó A MEDIAS, no falló — la sesión sigue viva y solo hace falta
 * pedirle que siga. Antes esto se reportaba como `error` y Samu tenía que
 * escribir "continúa" a mano para que retomara. Con tope: un turno que de
 * verdad no converge (bucle) no debe reintentar para siempre.
 *
 * De 3 a 1, por costo. El tope se combina con MAX_ATTEMPTS (reintentos por
 * fallo transitorio): en el peor caso, 3 intentos × (1 corrida + 3
 * continuaciones) eran 12 procesos `query()` completos por UN mensaje, cada
 * uno re-mandando el historial que crece — y cada uno de esos 12 podía además
 * escalar de modelo una vez (session.ts), así que el techo real de procesos
 * llegaba a 24. Con `maxTurns: 40` por proceso (antes de que también ese techo
 * se volviera por nivel, ver router.ts), eso son hasta 960 turnos del SDK por
 * un solo mensaje del usuario — el rango que confirmó el audit. Y la segunda y
 * la tercera continuación son las peores del lote: para llegar ahí el modelo
 * ya quemó su presupuesto DOS veces sin cerrar, que es la firma de estar dando
 * vueltas, no de estar avanzando. Una continuación cubre el caso legítimo (se
 * quedó corto por poco); las otras dos pagaban por un bucle. Si de verdad
 * falta trabajo, el turno cierra avisando y el humano decide si sigue — que es
 * más barato que adivinar tres veces.
 *
 * Subido de 1 a 2 (2026-09-03), pedido explícito del dueño tras un caso real:
 * una tarea larga de verdad (instalar dependencias, esperar una descarga,
 * depurar un puerto ocupado — "Autonomus qween") agotó la primera
 * continuación YA escalada a `alto` (el techo más alto que existe, sin más
 * nivel al que subir) y cerró en error a mitad del trabajo. Con solo 1
 * continuación, tocar el techo de `alto` significaba SIEMPRE fallar sin
 * alternativa — no había "dar una vuelta más" posible. La segunda
 * continuación sigue subiendo de nivel si puede (ver el escalado más abajo),
 * así que el costo extra es real pero acotado: solo se paga cuando la tarea
 * genuinamente lo necesita, no en el caso general (saludo, pregunta corta),
 * que sigue resolviéndose en la primera pasada.
 */
export const MAX_CONTINUATIONS = 2;
const CONTINUE_PROMPT =
  "Se acabó el presupuesto de turnos antes de que terminaras. Continúa EXACTAMENTE donde te quedaste: no repitas lo ya hecho, no vuelvas a saludar ni a resumir la tarea, sigue la ejecución y ciérrala.";

/**
 * Un error del agente es reintentable si huele a transitorio: red, límite de
 * tasa, sobrecarga o un proceso que murió. Un error de contenido ("no encontré
 * el archivo") NO se reintenta: reintentarlo da el mismo resultado tres veces
 * y triplica el gasto.
 */
export function isRetryable(message: string): boolean {
  const m = message.toLowerCase();
  return [
    "econnreset", "econnrefused", "etimedout", "enotfound", "eai_again",
    "socket hang up", "network", "fetch failed", "timeout", "aborted",
    "429", "500", "502", "503", "504", "529",
    "overloaded", "rate limit", "temporarily", "unavailable",
    "process exited", "sigkill", "sigterm",
  ].some((needle) => m.includes(needle));
}

/**
 * Qué merece entrar al historial. Regla del dominio, no del transporte: vive
 * aquí para que sea UNA y esté cubierta por los tests.
 *
 * Un turno cancelado no se guarda (el usuario decidió que no lo quería) y uno
 * sin texto tampoco (un error puro ensuciaría el hilo con un mensaje vacío).
 * Un turno que falló DESPUÉS de escribir sí se guarda: el usuario ya lo leyó,
 * y si al volver no estuviera, el hilo mentiría.
 */
export function shouldPersist(turn: ChatTurn): boolean {
  if (turn.status === "stopped") return false;
  return turn.text.trim().length > 0;
}

/**
 * Regla de dueño de un turno. Vive aquí (no en la ruta) por el mismo motivo
 * que `shouldPersist`: es una regla del dominio, cubierta por sus propios
 * tests.
 *
 * Un turno sin `userId` (HERMES_API_KEY estática, reloj) es visible para
 * cualquiera — así se comportaba TODO antes de que existiera `userId`, y
 * cambiarlo rompería el modo LAN/reloj sin login. Un requester sin `userId`
 * (misma credencial estática) también ve cualquier turno: es "full trust",
 * igual que hoy. Solo se niega cuando AMBOS lados tienen `userId` y no
 * coinciden — dos usuarios de Supabase distintos no pueden leer ni cancelar
 * el turno del otro.
 */
export function turnVisibleTo(turn: ChatTurn, requesterId?: string): boolean {
  return !requesterId || !turn.userId || turn.userId === requesterId;
}

// ── Dependencias inyectables ───────────────────────────────────────────
export interface TurnRunnerArgs {
  prompt: string;
  /** Rutas absolutas de imágenes adjuntas (ver ChatTurn.attachments). */
  attachments?: string[];
  project?: string;
  cwd?: string;
  /** Clave del hilo: fija el nivel del router. Ver RunTurnOptions. */
  sessionKey?: string;
  maxTier?: Tier;
  magro?: boolean;
  /** `false` en las auto-continuaciones: ver RunTurnOptions en session.ts. */
  precargarContexto?: boolean;
  resumeSessionId?: string;
  abortController: AbortController;
  onDelta: (text: string) => void;
  onSession: (sessionId: string) => void;
  onTool: (step: ChatToolStep) => void;
  onModel: (model: string, effort?: string) => void;
}

export interface TurnRunnerResult {
  sdkSessionId?: string;
  finalText: string;
  isError: boolean;
  /** Ver RunTurnResult.errorSubtype en session.ts. */
  errorSubtype?: string;
}

export interface TurnEngineDeps {
  run: (args: TurnRunnerArgs) => Promise<TurnRunnerResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Persistencia del turno cerrado. Best-effort: no debe tumbar el turno. */
  persist?: (turn: ChatTurn) => void;
  /**
   * Checkpoint del turno EN VUELO (best-effort, no bloquea ni tumba el
   * turno): sobrevive a un reinicio del proceso a mitad de una respuesta.
   * Se llama apenas se conoce `sdkSessionId` (para que el próximo mensaje
   * pueda retomar la MISMA conversación aunque esta respuesta se pierda) y,
   * con throttle, en cada delta mientras el turno escribe.
   */
  checkpoint?: (turn: ChatTurn) => void;
  /** Se llama al cerrar el turno (cualquier status): ya no hace falta el checkpoint. */
  clearCheckpoint?: (id: string) => void;
}

/** Cada cuánto se re-escribe el checkpoint mientras el turno escribe texto —
 *  no en cada delta, que sería un write por token. */
export const CHECKPOINT_INTERVAL_MS = 3000;

export interface StartTurnInput {
  prompt: string;
  /** Rutas absolutas de imágenes adjuntas (ver ChatTurn.attachments). */
  attachments?: string[];
  sessionKey: string;
  project?: string;
  cwd?: string;
  /** Dueño del turno (ver ChatTurn.userId). Ausente = HERMES_API_KEY/reloj. */
  userId?: string;
  /** Techo de nivel del turno. El canal del reloj lo fija en `light`. */
  maxTier?: Tier;
  /** Salta la precarga de contexto del prompt (canal del reloj). */
  magro?: boolean;
  resumeSessionId?: string;
}

export function createTurnEngine(deps: TurnEngineDeps) {
  const turns = new Map<string, ChatTurn>();
  const events = new Map<string, TurnEvent[]>();
  const seqs = new Map<string, number>();
  const truncatedIds = new Set<string>();
  const subs = new Map<string, Set<(e: TurnEvent) => void>>();
  const aborts = new Map<string, AbortController>();

  const emitEvent = (id: string, e: Omit<TurnEvent, "seq">): TurnEvent => {
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const full: TurnEvent = { ...e, seq };
    const buf = events.get(id);
    if (buf) {
      buf.push(full);
      if (buf.length > MAX_EVENTS) {
        buf.splice(0, buf.length - MAX_EVENTS);
        truncatedIds.add(id);
      }
    }
    // Un suscriptor que revienta no puede tumbar el turno ni a los demás.
    for (const cb of subs.get(id) ?? []) {
      try {
        cb(full);
      } catch {
        /* noop */
      }
    }
    return full;
  };

  /** Suelta turnos viejos: memoria acotada sin tocar los que siguen vivos. */
  const evict = () => {
    const cutoff = deps.now() - RETAIN_MS;
    for (const [id, t] of turns) {
      if (t.status !== "running" && (t.endedAt ?? t.startedAt) < cutoff) {
        turns.delete(id);
        events.delete(id);
        seqs.delete(id);
        truncatedIds.delete(id);
        subs.delete(id);
        aborts.delete(id);
      }
    }
    if (turns.size <= MAX_TURNS) return;
    const done = [...turns.values()]
      .filter((t) => t.status !== "running")
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    for (const t of done.slice(0, turns.size - MAX_TURNS)) {
      turns.delete(t.id);
      events.delete(t.id);
      seqs.delete(t.id);
      truncatedIds.delete(t.id);
      subs.delete(t.id);
      aborts.delete(t.id);
    }
  };

  /**
   * Arranca el turno y DEVUELVE de una: el trabajo sigue en segundo plano.
   * Quien llame no debe esperar la promesa del trabajo (no existe hacia fuera).
   */
  function start(input: StartTurnInput): ChatTurn {
    evict();
    const id = randomUUID();
    const turn: ChatTurn = {
      id,
      sessionKey: input.sessionKey,
      project: input.project || "general",
      prompt: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      status: "running",
      text: "",
      steps: [],
      attempts: 0,
      startedAt: deps.now(),
    };
    turns.set(id, turn);
    events.set(id, []);
    seqs.set(id, 0);
    void drive(turn, input);
    return turn;
  }

  async function drive(turn: ChatTurn, input: StartTurnInput) {
    // El resume avanza con los intentos: si el primer intento alcanzó a crear
    // la sesión del SDK, el reintento CONTINÚA esa y no abre una nueva.
    let resume = input.resumeSessionId;
    // Throttle del checkpoint de texto: independiente de los intentos, vive
    // para toda la vida del turno.
    let lastCheckpointAt = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      turn.attempts = attempt;
      // Prompt de ESTE intento: normalmente el original, pero la rama de
      // auto-continuación de abajo lo reemplaza por CONTINUE_PROMPT sin gastar
      // un `attempt` del presupuesto de reintentos por fallo transitorio —
      // seguir un trabajo a medias no es lo mismo que reintentar uno roto.
      let promptForRun = input.prompt;
      let continuations = 0;

      // eslint-disable-next-line no-constant-condition
      for (;;) {
        const abort = new AbortController();
        aborts.set(turn.id, abort);
        // Texto de ESTE intento: el reintento arranca de cero y no se pega al
        // parcial del intento anterior (eso duplicaba frases a medias). Una
        // continuación SÍ debe arrancar en cero por el mismo motivo: lo que
        // ya escribió antes de quedarse sin turnos vive en `turn.text`.
        let attemptText = "";
        let failure: string | null = null;
        let errorSubtype: string | undefined;
        /**
         * De dónde salió el fallo. `transporte` = una excepción real de esta
         * capa (red, proceso muerto); `modelo` = el turno cerró con
         * `isError` y lo único que hay es la PROSA del modelo.
         *
         * La distinción importa porque `isRetryable()` hace match de
         * subcadenas ("timeout", "500", "502", "network", "rate limit",
         * "unavailable"…) y aplicárselo al texto del modelo es un error de
         * categoría con factura: Hermes es un asistente técnico que habla de
         * códigos HTTP a diario, así que una respuesta como "el endpoint
         * devolvió 500" se leía como un fallo transitorio y RE-EJECUTABA el
         * mensaje entero, hasta 3 veces. El guardia `partial` no lo tapaba:
         * solo mira si llegaron deltas, y el SDK puede cerrar con el texto
         * final sin haber mandado ninguno (ver más abajo).
         */
        let failureSource: "transporte" | "modelo" | null = null;

        try {
          const result = await deps.run({
            prompt: promptForRun,
            // Del turno, no del input: es la misma lista, pero leerla de `turn`
            // deja claro que cada reintento/continuación manda los adjuntos
            // otra vez.
            attachments: turn.attachments,
            project: input.project,
            cwd: input.cwd,
            resumeSessionId: resume,
            // El nivel se fija por HILO, y el hilo es la pestaña del chat: es
            // la única clave que existe ya en el primer mensaje.
            sessionKey: input.sessionKey,
            maxTier: input.maxTier,
            magro: input.magro,
            // La recuperación semántica se hace con el mensaje REAL. En una
            // continuación el mensaje es CONTINUE_PROMPT, un "sigue"
            // sintético: buscar conocimiento con eso trae ruido y se paga
            // igual (y el contexto que hacía falta ya está en el historial).
            precargarContexto: continuations === 0,
            abortController: abort,
            onSession: (sessionId) => {
              if (turn.sdkSessionId === sessionId) return;
              turn.sdkSessionId = sessionId;
              resume = sessionId;
              emitEvent(turn.id, { kind: "session", sessionId });
              // Checkpoint INMEDIATO, sin throttle: es el dato más valioso del
              // turno (deja retomar la MISMA conversación del SDK aunque esta
              // respuesta puntual se pierda en un reinicio) y no pasa seguido.
              deps.checkpoint?.(turn);
              lastCheckpointAt = deps.now();
            },
            onDelta: (text) => {
              if (!text) return;
              attemptText += text;
              turn.text += text;
              emitEvent(turn.id, { kind: "delta", text });
              const now = deps.now();
              if (now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
                lastCheckpointAt = now;
                deps.checkpoint?.(turn);
              }
            },
            onTool: (tool) => {
              turn.steps.push(tool);
              emitEvent(turn.id, { kind: "tool", tool });
            },
            onModel: (model, effort) => {
              // Sin cambio no se emite: el escalado repite la llamada y no vale
              // gastar un seq (ni repintar) para decir lo mismo otra vez.
              if (turn.model === model && turn.effort === effort) return;
              turn.model = model;
              turn.effort = effort;
              emitEvent(turn.id, { kind: "model", model, effort });
            },
          });
          if (!result.isError) {
            // El SDK puede cerrar con el texto final sin haber mandado deltas.
            if (!attemptText && result.finalText) {
              turn.text += result.finalText;
              emitEvent(turn.id, { kind: "delta", text: result.finalText });
            }
            if (result.sdkSessionId) turn.sdkSessionId = result.sdkSessionId;
            return close(turn, "done");
          }
          failure = result.finalText || "el agente terminó con error";
          errorSubtype = result.errorSubtype;
          failureSource = "modelo";
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          failureSource = "transporte";
        }

        // Cancelación explícita: no es un fallo y no se reintenta.
        if (abort.signal.aborted) return close(turn, "stopped", failure ?? undefined);

        // Se acabó `maxTurns` con el trabajo a medias: NO es un error de
        // verdad. La sesión del SDK sigue viva (`resume` ya se actualizó por
        // `onSession`), así que se le pide que siga sola — es justo lo que
        // antes obligaba a Samu a escribir "continúa" a mano.
        if (errorSubtype === "error_max_turns" && resume && continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          // Antes esto SOLO continuaba en el mismo nivel — funciona cuando el
          // trabajo iba bien y nomás faltaba tiempo, pero si el router clasificó
          // corto de entrada (una "pregunta de estado" que resultó ser una
          // investigación de verdad en trivial/haiku, maxTurns:6) continuar en
          // el MISMO nivel solo compra 6 turnos más y choca otra vez — visto en
          // producción con una tarea de 19 pasos. Al escalar la sesión un nivel
          // (misma infraestructura que el escalado de session.ts ante fallos
          // reales, ver su comentario) la continuación corre con más
          // capacidad Y más presupuesto de turnos, en vez de repetir el mismo
          // techo que ya se demostró insuficiente.
          const currentTier = routeTurn(promptForRun, input.sessionKey).tier;
          const up = nextTier(currentTier);
          if (up) escalateSession(input.sessionKey, up);
          emitEvent(turn.id, {
            kind: "retry",
            attempt: continuations,
            text: up
              ? `se acabó el presupuesto de turnos — subo a ${up} y sigo…`
              : "se acabó el presupuesto de turnos — continuando solo…",
          });
          promptForRun = CONTINUE_PROMPT;
          continue;
        }

        const last = attempt === MAX_ATTEMPTS;
        // Con texto ya entregado no se reintenta: el cliente lo está leyendo y
        // un segundo intento le repetiría media respuesta encima.
        const partial = attemptText.length > 0;
        // Solo se juzga como transitorio lo que vino de ESTA capa (una
        // excepción) o lo que el SDK marcó como error de API. La prosa del
        // modelo no se pasa nunca por `isRetryable` — ver `failureSource`.
        const transitorio =
          failureSource === "transporte"
            ? isRetryable(failure ?? "")
            : errorSubtype === "api_error";
        if (last || partial || !transitorio) {
          // Con error_max_turns y sin texto que mostrar, `finalText` suele ser
          // el string crudo que el SDK arma para su PROPIA excepción interna
          // ("Claude Code returned an error result: Reached maximum number of
          // turns (N)") — nada que Samu pueda accionar. Si ya se gastó la
          // continuación (ver arriba) y sigue sin alcanzar, decirlo en
          // español y con una salida real es mejor que reenviar el texto
          // interno del SDK tal cual.
          const failureMsg =
            errorSubtype === "error_max_turns"
              ? "Se me acabó el presupuesto de turnos investigando esto — probá pedirlo más acotado (un archivo o proyecto puntual en vez de todo)."
              : (failure ?? "error desconocido");
          return close(turn, "error", failureMsg);
        }
        emitEvent(turn.id, { kind: "retry", attempt: attempt + 1, text: failure ?? "" });
        await deps.sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        break;
      }
    }
  }

  function close(turn: ChatTurn, status: TurnStatus, error?: string) {
    if (turn.status !== "running") return;
    turn.status = status;
    turn.endedAt = deps.now();
    if (error) turn.error = error;
    emitEvent(turn.id, {
      kind: status === "done" ? "done" : status === "stopped" ? "stopped" : "error",
      text: error,
    });
    aborts.delete(turn.id);
    // El turno ya no está "en vuelo": el checkpoint cumplió su función (si
    // el proceso llegó hasta acá, no hace falta reconciliar nada al arrancar).
    try {
      deps.clearCheckpoint?.(turn.id);
    } catch {
      /* best-effort */
    }
    // Persistir aquí y no en la ruta: el turno se guarda aunque nadie esté
    // escuchando — que es justo el caso que rompía todo.
    if (!shouldPersist(turn)) return;
    try {
      deps.persist?.(turn);
    } catch {
      /* best-effort */
    }
  }

  /** Cancelación explícita (⏹). Distinta de "el cliente se fue". */
  function stop(id: string): boolean {
    const turn = turns.get(id);
    if (!turn || turn.status !== "running") return false;
    aborts.get(id)?.abort();
    return true;
  }

  function get(id: string): ChatTurn | undefined {
    return turns.get(id);
  }

  /** Snapshot con los eventos DESDE `from` (exclusivo). */
  function snapshot(id: string, from = 0): TurnSnapshot | undefined {
    const turn = turns.get(id);
    if (!turn) return undefined;
    const buf = events.get(id) ?? [];
    const pending = buf.filter((e) => e.seq > from);
    // Hueco real: el cliente pide desde un seq que ya se botó del buffer.
    const truncated =
      truncatedIds.has(id) && buf.length > 0 && from > 0 && buf[0].seq > from + 1;
    return { ...turn, events: pending, seq: seqs.get(id) ?? 0, truncated };
  }

  /**
   * Suscripción + snapshot en el MISMO tick: sin await entre medias no hay
   * ventana donde un evento caiga entre el replay y la suscripción.
   */
  function attach(
    id: string,
    from: number,
    cb: (e: TurnEvent) => void,
  ): { snapshot: TurnSnapshot; unsubscribe: () => void } | undefined {
    const snap = snapshot(id, from);
    if (!snap) return undefined;
    const set = subs.get(id) ?? new Set();
    subs.set(id, set);
    set.add(cb);
    return {
      snapshot: snap,
      unsubscribe: () => {
        set.delete(cb);
      },
    };
  }

  /** Turnos de un tab, del más nuevo al más viejo (para re-adjuntarse al volver). */
  function listBySession(sessionKey: string, limit = 5): ChatTurn[] {
    return [...turns.values()]
      .filter((t) => t.sessionKey === sessionKey)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  return { start, stop, get, snapshot, attach, listBySession, _size: () => turns.size };
}

export type TurnEngine = ReturnType<typeof createTurnEngine>;

// ── Instancia de producción ────────────────────────────────────────────
export const chatTurns: TurnEngine = createTurnEngine({
  run: async (args) => {
    const r = await runAgentTurn({
      prompt: args.prompt,
      attachments: args.attachments,
      project: args.project,
      cwd: args.cwd,
      // OJO: este adaptador copia campo a campo, no hace spread. Añadir una
      // opción arriba sin añadirla AQUÍ la deja perdiéndose en silencio en el
      // último salto — que es exactamente lo que pasó con maxTier.
      maxTier: args.maxTier,
      magro: args.magro,
      sessionKey: args.sessionKey,
      precargarContexto: args.precargarContexto,
      resumeSessionId: args.resumeSessionId,
      abortController: args.abortController,
      onDelta: args.onDelta,
      onSession: args.onSession,
      onTool: args.onTool,
      onModel: args.onModel,
    });
    return {
      sdkSessionId: r.sdkSessionId,
      finalText: r.finalText,
      isError: r.isError,
      errorSubtype: r.errorSubtype,
    };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  persist: (turn) => {
    // Al historial va el mensaje del usuario TAL CUAL escribió, más una nota de
    // cuántas imágenes traía. Las rutas del .data no van: son efímeras (se
    // barren a los 30 días) y ensuciarían la búsqueda semántica con ruido que
    // no significa nada para el Samu que relea esto en dos meses.
    const stored = turn.prompt + attachmentNote(turn.attachments?.length ?? 0);
    void appendTurn(turn.project, stored, turn.text, turn.sessionKey, turn.userId);
    if (turn.sdkSessionId) void saveSdkSession(turn.sessionKey, turn.sdkSessionId, "text");
  },
  checkpoint: (turn) => checkpointTurn(turn, env.MACHINE_NAME),
  clearCheckpoint: (id) => clearCheckpoint(id),
});
