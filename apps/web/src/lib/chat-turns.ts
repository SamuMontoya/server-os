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
  /**
   * Ids de imágenes ya subidas con `uploadChatImage`. Van como ids y no como
   * base64 a propósito: el turno se manda igual de rápido con 4 capturas que
   * sin ninguna, y el servidor le pasa al modelo la RUTA en disco (que abre
   * con Read) en vez de inflar el JSON del turno. Ver lib/chat-attachments.ts.
   */
  attachments?: string[];
}): Promise<string> {
  const res = await hermesFetch("/chat/turns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      session_key: input.sessionKey,
      project: input.project ?? undefined,
      resume: input.resume ?? undefined,
      attachments: input.attachments?.length ? input.attachments : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Hermes no aceptó el turno (${res.status}). ¿El agente está arriba?`);
  }
  const data = (await res.json()) as { turn_id?: string; error?: string };
  if (!data.turn_id) throw new Error(data.error || "el agente no devolvió turno");
  return data.turn_id;
}

/**
 * Nombre corto (2-3 palabras) para el chat, a partir de su primer mensaje.
 * Lo genera haiku en el servidor (agent/chat-title.ts). Devuelve "" ante
 * cualquier problema: es un adorno, jamás debe romper ni demorar un envío —
 * por eso quien llama lo dispara sin await y pinta el título cuando llegue.
 */
export async function fetchChatTitle(message: string): Promise<string> {
  try {
    const res = await hermesFetch("/chat/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { title?: string };
    return (data.title ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Vincula este turno al reloj: es lo que sigue `GET /watch/link` en el Watch
 * (ver watch/active-link.ts en el servidor). Se dispara sin await, igual que
 * el título — es un adorno del chat en curso, nunca debe demorar el envío ni
 * romperlo si el agente no responde.
 */
export async function linkWatchTurn(turnId: string, title: string): Promise<void> {
  try {
    await hermesFetch("/watch/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn_id: turnId, title }),
    });
  } catch {
    // Sin reloj vinculado, o el agente no respondió: no es un error del chat.
  }
}

/** Corta el vínculo con el reloj YA — no solo deja de renovarlo con el
 *  próximo turno, borra el puntero del servidor de una. Mismo criterio de
 *  "adorno, nunca revienta el chat" que linkWatchTurn. */
export async function unlinkWatchTurn(): Promise<void> {
  try {
    await hermesFetch("/watch/link", { method: "DELETE" });
  } catch {
    // No hay mucho que hacer si el agente no respondió: el vínculo vence
    // solo a las 2h del lado del servidor (ver watch/active-link.ts).
  }
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

/**
 * Como `fetchTurn`, pero no se rinde ante un tropiezo transitorio: un 401
 * porque el JWT de Supabase estaba a punto de refrescarse (típico al volver
 * de segundo plano largo, donde el timer de auto-refresh estuvo congelado),
 * un 5xx del agente reiniciándose, o un blip de red — nada de eso significa
 * que el turno "se perdió". Solo un 404 real (el turno ya no existe en el
 * servidor) es una pérdida genuina.
 *
 * Sin esto, `resumePending`/`resumePendingTurns` declaraban perdido un turno
 * que seguía vivísimo del otro lado por culpa de un solo fetch fallido, y
 * Samu tenía que repetir la pregunta con el agente todavía trabajando.
 *
 * Devuelve `"not-found"` (pérdida real, confirmada) o el estado; `null` solo
 * cuando se agotan los reintentos SIN poder confirmar nada — el llamador debe
 * tratarlo como "todavía no se sabe", no como "perdido".
 */
export async function fetchTurnResilient(
  turnId: string,
  from = 0,
  tries = 4,
): Promise<TurnState | "not-found" | null> {
  const delays = [400, 1200, 2500, 5000];
  for (let i = 0; i < tries; i++) {
    try {
      const res = await hermesFetch(`/chat/turns/${turnId}?from=${from}`);
      if (res.status === 404) return "not-found";
      if (res.ok) return (await res.json()) as TurnState;
    } catch {
      /* red caída a mitad de la reconexión: se reintenta */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delays[i]));
  }
  return null;
}

/** Reintentos de conexión antes de rendirse (el turno sigue vivo del otro lado). */
const MAX_RECONNECTS = 5;
const RECONNECT_MS = [500, 1500, 3000, 6000, 10_000];

/**
 * Silencio máximo tolerado antes de dar la conexión por muerta y reengancharse.
 *
 * El servidor manda un `ping` cada 15 s (ver /chat/turns/:id/stream), así que
 * 45 s son tres latidos perdidos: no es un turno lento, es un socket muerto.
 *
 * Esto existe porque `onerror` NO siempre llega. iOS congela la pestaña al
 * bloquear la pantalla o al salir de la PWA; el socket queda medio abierto y
 * al volver el EventSource sigue diciendo que está conectado mientras no
 * entra un solo byte. Ese era el caso en que "se moría la sesión": el turno
 * seguía corriendo en el servidor y la pantalla se quedaba mirando un stream
 * que ya no existía.
 */
const STALE_MS = 45_000;
/** Cada cuánto se revisa el silencio. */
const WATCHDOG_MS = 5_000;
/** Al volver a primer plano no se esperan 45 s: si el último byte es más viejo
 *  que esto, se reengancha en el acto (es cuando iOS ya mató la conexión). */
const RESUME_STALE_MS = 8_000;

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
  /** Último byte recibido del servidor (evento o latido). Es el reloj del
   *  watchdog: mientras avance, la conexión está viva de verdad. */
  let lastBeat = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  /** Cierra SOLO el socket (el turno sigue vivo del otro lado). */
  const closeEs = () => {
    es?.close();
    es = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Cierra todo, incluido el watchdog: solo al terminar o al desengancharse. */
  const cleanup = () => {
    closeEs();
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    document.removeEventListener("visibilitychange", onVisible);
  };

  /**
   * Reengancha YA, sin gastar presupuesto de reintentos: no es un fallo de
   * conexión, es una conexión que se quedó muda. El cursor `seq` va al día,
   * así que el servidor replayea exactamente lo que faltó y no se duplica ni
   * se pierde un delta.
   */
  const reconnectNow = () => {
    if (closed) return;
    closeEs();
    lastBeat = Date.now();
    tries = 0;
    open();
  };

  function onVisible() {
    if (closed) return;
    if (document.visibilityState !== "visible") return;
    // Volvimos a primer plano. Si hace rato que no entra nada, la conexión
    // que "sigue abierta" es un fantasma: se rehace sin esperar al watchdog.
    if (Date.now() - lastBeat > RESUME_STALE_MS) reconnectNow();
  }

  const open = () => {
    if (closed) return;
    lastBeat = Date.now();
    es = new EventSource(sseUrl(`/chat/turns/${turnId}/stream?from=${seq}`));

    // Latido del servidor: no lleva datos, solo prueba que el socket vive.
    es.addEventListener("ping", () => {
      lastBeat = Date.now();
    });

    es.addEventListener("state", (ev) => {
      lastBeat = Date.now();
      const state = JSON.parse((ev as MessageEvent).data) as TurnState;
      seq = Math.max(seq, state.seq);
      tries = 0; // conexión buena: el presupuesto de reintentos se renueva
      handlers.onState?.(state);
    });

    es.addEventListener("turn", (ev) => {
      lastBeat = Date.now();
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
        closed = true;
        cleanup(); // sin esto quedaban vivos el watchdog y el listener
        handlers.onDisconnected?.(seq);
        return;
      }
      timer = setTimeout(open, RECONNECT_MS[tries - 1] ?? 10_000);
    };
  };

  open();
  // El watchdog vive fuera de `open`: sobrevive a las reconexiones y es lo
  // único que detecta el caso feo (socket abierto pero mudo), donde `onerror`
  // nunca llega y por tanto nadie se entera de que hay que reenganchar.
  watchdog = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastBeat > STALE_MS) reconnectNow();
  }, WATCHDOG_MS);
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    closed = true;
    cleanup();
  };
}
