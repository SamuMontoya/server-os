/**
 * Cliente de los turnos del chat (servidor: apps/agent/src/agent/chat-turns.ts).
 *
 * La diferencia con `streamChat` es toda la gracia: ahí el turno vivía dentro
 * del fetch, así que si el navegador cortaba la conexión —iOS congelando la
 * pestaña al bloquear la pantalla— el turno se daba por perdido. Aquí el turno
 * es un trabajo del servidor con id propio: se arranca, se escucha, y si se
 * pierde la conexión se vuelve a enganchar DESDE EL CURSOR (`seq`). Irse no
 * cancela nada; cancelar es pulsar ⏹.
 */
import { hermesFetch, sseUrl } from "@/lib/hermes";
import type { ChatToolStep } from "@hermes/shared";

export type TurnStatus = "running" | "done" | "error" | "stopped";

export interface TurnState {
  status: TurnStatus;
  /** Texto ÍNTEGRO acumulado en el servidor: con esto se repinta sin dudas. */
  text: string;
  steps: ChatToolStep[];
  seq: number;
  /** El buffer botó eventos: hay que repintar con `text`, no concatenar. */
  truncated: boolean;
  attempts: number;
  sdkSessionId?: string;
  /** Modelo que el router puso a correr este turno ("opus"|"sonnet"|"haiku"). */
  model?: string;
  effort?: string;
  error?: string;
}

export interface TurnHandlers {
  /** Snapshot al conectar (y en cada reconexión). */
  onState?: (state: TurnState) => void;
  onDelta?: (text: string, seq: number) => void;
  onTool?: (step: ChatToolStep, seq: number) => void;
  onSession?: (sdkSessionId: string) => void;
  /** El router eligió modelo (o escaló a uno mayor a mitad del turno). */
  onModel?: (model: string, effort?: string) => void;
  /** El servidor se cayó y va a reintentar: se puede decir "reintentando 2/3". */
  onRetry?: (attempt: number, reason: string) => void;
  onEnd?: (status: TurnStatus, seq: number) => void;
  /** Se agotaron las reconexiones del navegador. El turno puede seguir vivo. */
  onDisconnected?: (lastSeq: number) => void;
}

export async function startTurn(input: {
  message: string;
  sessionKey: string;
  /** El foco de proyecto llega como `string | null` desde el workspace. */
  project?: string | null;
  resume?: string | null;
}): Promise<string> {
  const res = await hermesFetch("/chat/turns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      session_key: input.sessionKey,
      project: input.project ?? undefined,
      resume: input.resume ?? undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Hermes no aceptó el turno (${res.status}). ¿El agente está arriba?`);
  }
  const data = (await res.json()) as { turn_id?: string; error?: string };
  if (!data.turn_id) throw new Error(data.error || "el agente no devolvió turno");
  return data.turn_id;
}

/** Estado del turno sin abrir stream. Para saber si vale la pena engancharse. */
export async function fetchTurn(turnId: string, from = 0): Promise<TurnState | null> {
  const res = await hermesFetch(`/chat/turns/${turnId}?from=${from}`);
  if (!res.ok) return null;
  return (await res.json()) as TurnState;
}

export async function stopTurn(turnId: string): Promise<boolean> {
  try {
    const res = await hermesFetch(`/chat/turns/${turnId}/stop`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reintentos de conexión antes de rendirse (el turno sigue vivo del otro lado). */
const MAX_RECONNECTS = 5;
const RECONNECT_MS = [500, 1500, 3000, 6000, 10_000];

/**
 * Engancha el turno desde `from` y lo sigue hasta que cierre.
 *
 * La reconexión la manejamos a mano en vez de dejársela a EventSource: el
 * reintento nativo repite la MISMA url, o sea el mismo `from`, y volvería a
 * mandar deltas ya pintados. Aquí cada reconexión usa el cursor actualizado.
 *
 * Devuelve una función para desengancharse (no cancela el turno).
 */
export function attachTurn(
  turnId: string,
  from: number,
  handlers: TurnHandlers,
): () => void {
  let seq = from;
  let closed = false;
  let tries = 0;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    es?.close();
    es = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const open = () => {
    if (closed) return;
    es = new EventSource(sseUrl(`/chat/turns/${turnId}/stream?from=${seq}`));

    es.addEventListener("state", (ev) => {
      const state = JSON.parse((ev as MessageEvent).data) as TurnState;
      seq = Math.max(seq, state.seq);
      tries = 0; // conexión buena: el presupuesto de reintentos se renueva
      handlers.onState?.(state);
    });

    es.addEventListener("turn", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as {
        seq: number;
        kind: string;
        text?: string;
        tool?: ChatToolStep;
        sessionId?: string;
        model?: string;
        effort?: string;
        attempt?: number;
      };
      // Defensa contra el replay repetido: nunca procesar hacia atrás.
      if (e.seq <= seq) return;
      seq = e.seq;
      switch (e.kind) {
        case "delta":
          if (e.text) handlers.onDelta?.(e.text, e.seq);
          break;
        case "tool":
          if (e.tool) handlers.onTool?.(e.tool, e.seq);
          break;
        case "session":
          if (e.sessionId) handlers.onSession?.(e.sessionId);
          break;
        case "model":
          if (e.model) handlers.onModel?.(e.model, e.effort);
          break;
        case "retry":
          handlers.onRetry?.(e.attempt ?? 0, e.text ?? "");
          break;
        case "done":
        case "error":
        case "stopped":
          handlers.onEnd?.(e.kind as TurnStatus, e.seq);
          closed = true;
          cleanup();
          break;
      }
    });

    es.addEventListener("end", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { status: TurnStatus; seq: number };
      if (!closed) handlers.onEnd?.(data.status, data.seq);
      closed = true;
      cleanup();
    });

    es.onerror = () => {
      if (closed) return;
      es?.close();
      es = null;
      if (++tries > MAX_RECONNECTS) {
        // Rendirse en la CONEXIÓN, no en el turno: sigue corriendo en el
        // servidor y se puede recuperar con fetchTurn/attachTurn más tarde.
        handlers.onDisconnected?.(seq);
        closed = true;
        return;
      }
      timer = setTimeout(open, RECONNECT_MS[tries - 1] ?? 10_000);
    };
  };

  open();
  return () => {
    closed = true;
    cleanup();
  };
}
