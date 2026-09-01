/**
 * Turnos DURABLES para el reloj.
 *
 * EL PROBLEMA QUE RESUELVE
 * watchOS suspende la app al bajar la muñeca, y eso mata el SSE en vuelo. Con
 * `/watch/ask` a pelo, la respuesta se perdía: el stream era el turno. Y no se
 * arregla en el cliente — no hay background session para data tasks ni
 * WebSocket en watchOS (TN3135).
 *
 * Así que el turno pasa a ser un TRABAJO DEL SERVIDOR con id propio y sus
 * eventos numerados, igual que ya hace el chat del dashboard
 * (`agent/chat-turns.ts`). Bajar la muñeca deja de cancelar nada: al volver, el
 * reloj se re-engancha DESDE SU CURSOR y recupera lo que se perdió.
 *
 * Es una versión reducida a propósito: el reloj no necesita reintentos del
 * modelo ni persistencia en base, solo sobrevivir a que la pantalla se apague.
 */

export type EventoTurno = { seq: number; tipo: string; datos: unknown };

interface Turno {
  id: string;
  eventos: EventoTurno[];
  seq: number;
  estado: "corriendo" | "hecho" | "error";
  /** Texto íntegro acumulado: con esto el cliente repinta sin dudas. */
  texto: string;
  creado: number;
  /** Quien esté escuchando ahora mismo. Puede no haber nadie. */
  oyentes: Set<(e: EventoTurno) => void>;
}

const turnos = new Map<string, Turno>();

/** Se retienen 20 minutos: lo que tarda una muñeca en volver a subir. */
const VIDA_MS = 20 * 60_000;
const MAX = 40;

function limpiar(): void {
  const ahora = Date.now();
  for (const [id, t] of turnos) {
    if (ahora - t.creado > VIDA_MS) turnos.delete(id);
  }
  // Techo duro por si llegan muchos seguidos: se van los más viejos.
  if (turnos.size > MAX) {
    const orden = [...turnos.entries()].sort((a, b) => a[1].creado - b[1].creado);
    for (const [id] of orden.slice(0, turnos.size - MAX)) turnos.delete(id);
  }
}

export function crear(id: string): Turno {
  limpiar();
  const t: Turno = {
    id,
    eventos: [],
    seq: 0,
    estado: "corriendo",
    texto: "",
    creado: Date.now(),
    oyentes: new Set(),
  };
  turnos.set(id, t);
  return t;
}

/**
 * Emite un evento: lo guarda Y lo reparte.
 *
 * Guardarlo es lo que permite el re-enganche. Repartirlo a cero oyentes es
 * normal y correcto: el turno sigue trabajando aunque nadie escuche, que es
 * justo el punto.
 */
export function emitir(id: string, tipo: string, datos: unknown = {}): void {
  const t = turnos.get(id);
  if (!t) return;
  t.seq += 1;
  const e: EventoTurno = { seq: t.seq, tipo, datos };
  t.eventos.push(e);
  if (tipo === "delta") {
    const txt = (datos as { text?: string }).text;
    if (txt) t.texto += txt;
  }
  if (tipo === "fin") t.estado = "hecho";
  if (tipo === "error") t.estado = "error";
  for (const o of t.oyentes) {
    try {
      o(e);
    } catch {
      /* un oyente roto no puede tumbar el turno */
    }
  }
}

/** Lo ocurrido desde `desde`, más el estado. Es lo que pide quien vuelve. */
export function snapshot(id: string, desde = 0) {
  const t = turnos.get(id);
  if (!t) return null;
  return {
    estado: t.estado,
    texto: t.texto,
    seq: t.seq,
    eventos: t.eventos.filter((e) => e.seq > desde),
  };
}

export function existe(id: string): boolean {
  return turnos.has(id);
}

/** Se engancha desde `desde`; devuelve cómo desengancharse. */
export function seguir(
  id: string,
  desde: number,
  alRecibir: (e: EventoTurno) => void,
): (() => void) | null {
  const t = turnos.get(id);
  if (!t) return null;
  // Primero lo que ya pasó, y solo después se suscribe: al revés se perdería
  // lo que llegue entre la lectura y la suscripción.
  for (const e of t.eventos) if (e.seq > desde) alRecibir(e);
  if (t.estado !== "corriendo") return () => {};
  t.oyentes.add(alRecibir);
  return () => t.oyentes.delete(alRecibir);
}
