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
import type { ChatToolStep } from "@hermes/shared";
import { runAgentTurn, saveSdkSession } from "./session.js";
import { appendTurn } from "../conversations.js";

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
  /** En `model`: alias del modelo ("opus"|"sonnet"|"haiku") y su esfuerzo. */
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

// ── Dependencias inyectables ───────────────────────────────────────────
export interface TurnRunnerArgs {
  prompt: string;
  project?: string;
  cwd?: string;
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
}

export interface TurnEngineDeps {
  run: (args: TurnRunnerArgs) => Promise<TurnRunnerResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Persistencia del turno cerrado. Best-effort: no debe tumbar el turno. */
  persist?: (turn: ChatTurn) => void;
}

export interface StartTurnInput {
  prompt: string;
  sessionKey: string;
  project?: string;
  cwd?: string;
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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      turn.attempts = attempt;
      const abort = new AbortController();
      aborts.set(turn.id, abort);
      // Texto de ESTE intento: el reintento arranca de cero y no se pega al
      // parcial del intento anterior (eso duplicaba frases a medias).
      let attemptText = "";
      let failure: string | null = null;

      try {
        const result = await deps.run({
          prompt: input.prompt,
          project: input.project,
          cwd: input.cwd,
          resumeSessionId: resume,
          abortController: abort,
          onSession: (sessionId) => {
            if (turn.sdkSessionId === sessionId) return;
            turn.sdkSessionId = sessionId;
            resume = sessionId;
            emitEvent(turn.id, { kind: "session", sessionId });
          },
          onDelta: (text) => {
            if (!text) return;
            attemptText += text;
            turn.text += text;
            emitEvent(turn.id, { kind: "delta", text });
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
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }

      // Cancelación explícita: no es un fallo y no se reintenta.
      if (abort.signal.aborted) return close(turn, "stopped", failure ?? undefined);

      const last = attempt === MAX_ATTEMPTS;
      // Con texto ya entregado no se reintenta: el cliente lo está leyendo y
      // un segundo intento le repetiría media respuesta encima.
      const partial = attemptText.length > 0;
      if (last || partial || !isRetryable(failure ?? "")) {
        return close(turn, "error", failure ?? "error desconocido");
      }
      emitEvent(turn.id, { kind: "retry", attempt: attempt + 1, text: failure ?? "" });
      await deps.sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
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
      project: args.project,
      cwd: args.cwd,
      resumeSessionId: args.resumeSessionId,
      abortController: args.abortController,
      onDelta: args.onDelta,
      onSession: args.onSession,
      onTool: args.onTool,
      onModel: args.onModel,
    });
    return { sdkSessionId: r.sdkSessionId, finalText: r.finalText, isError: r.isError };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  persist: (turn) => {
    void appendTurn(turn.project, turn.prompt, turn.text, turn.sessionKey);
    if (turn.sdkSessionId) void saveSdkSession(turn.sessionKey, turn.sdkSessionId, "text");
  },
});
