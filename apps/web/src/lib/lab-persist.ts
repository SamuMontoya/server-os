/**
 * El hilo de /laboratorio, guardado en el navegador.
 *
 * Hermano de chat-persist.ts (el mismo patrón, para el chat viejo/deprecado):
 * localStorage propio, recorte por cuota, versión de esquema, y un
 * `pendingTurn` que es lo que permite volver horas después —o que iOS mate la
 * pestaña en segundo plano y la resucite— y re-engancharse al turno que sigue
 * vivo en el servidor, en vez de ver un hilo cortado a media respuesta o, peor,
 * un chat completamente en blanco.
 *
 * Va en su propio storage (no reusa STORAGE_KEY de chat-persist.ts) para no
 * mezclar el hilo de /laboratorio con el del panel viejo: son dos historiales
 * independientes y no deben pisarse.
 *
 * Puro a propósito (nada de React ni de red): la parte con reglas —qué se
 * recorta, en qué orden, qué se descarta— es la que conviene poder testear
 * con node a secas.
 */
import type { ChatToolStep } from "@hermes/shared";

export type LabBlock =
  | { kind: "text"; text: string }
  | { kind: "steps"; steps: ChatToolStep[] };

export type LabMessage = {
  id: number;
  role: "user" | "assistant";
  /** Texto plano del mensaje del usuario. En el asistente vive en `blocks`. */
  content: string;
  /** Respuesta del asistente, en orden cronológico (ver LabBlock). */
  blocks?: LabBlock[];
  /** Imágenes que iban con el mensaje (solo en mensajes del usuario): quedan
   *  visibles en la burbuja, como el adjunto que fueron. */
  images?: { url: string; name: string }[];
};

/** Turno del motor que este hilo dejó corriendo (agent/chat-turns.ts). */
export interface PendingLabTurn {
  id: string;
  /** Último `seq` que el cliente alcanzó a ver: el cursor del replay. */
  seq: number;
}

/** Un hilo continuo (no hay tabs en /laboratorio: una conversación por proyecto). */
export interface LabThread {
  /** sesión SDK que este hilo resume (uuid del jsonl); null = aún sin crear. */
  sdkSessionId: string | null;
  /** Id de sesión del CLIENTE (agrupa turnos del mismo hilo). Vacío = generar uno nuevo. */
  sessionKey: string;
  messages: LabMessage[];
  draft: string;
  /** Último modelo con el que respondió (ver comentario en laboratorio/page.tsx). */
  model: string | null;
  /** Turno en vuelo. Se persiste: es lo que permite reengancharse al volver. */
  pendingTurn?: PendingLabTurn;
}

/** Estado completo del laboratorio: un hilo por proyecto en foco. */
export interface PersistedLab {
  v: number;
  /** projectKey ("general" o el slug) → su hilo. */
  byProject: Record<string, LabThread>;
  savedAt: number;
}

export const STORAGE_KEY = "hermes_os_lab_chat";
/** Subir esto invalida lo guardado (cambio de forma incompatible). */
export const SCHEMA_VERSION = 1;

// ── Recortes ───────────────────────────────────────────────────────────
const MAX_PROJECTS = 6;
const MAX_MESSAGES = 60;
const MAX_CHARS_PER_BLOCK = 12_000;
const MAX_BYTES = 900_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function trimText(text: string): string {
  return text.length <= MAX_CHARS_PER_BLOCK
    ? text
    : `${text.slice(0, MAX_CHARS_PER_BLOCK)}\n\n[…recortado]`;
}

function trimBlocks(blocks: LabBlock[] | undefined): LabBlock[] | undefined {
  if (!blocks) return blocks;
  return blocks.map((b) => (b.kind === "text" ? { kind: "text" as const, text: trimText(b.text) } : b));
}

function trimMessage(m: LabMessage): LabMessage {
  // Los `images[].url` son object URLs LOCALES: se revocan al desmontar la
  // página (ver laboratorio/page.tsx), así que tras recargar apuntarían a un
  // blob muerto. Persistirlos dejaría una imagen rota — se descartan.
  const { images: _images, ...rest } = m;
  return { ...rest, content: trimText(m.content), blocks: trimBlocks(m.blocks) };
}

function trimThread(thread: LabThread, maxMessages = MAX_MESSAGES): LabThread {
  return { ...thread, messages: thread.messages.slice(-maxMessages).map(trimMessage) };
}

/** Nada que guardar: un hilo virgen no merece ocupar cuota. */
function worthKeeping(thread: LabThread): boolean {
  return thread.messages.length > 0 || thread.draft.trim().length > 0 || !!thread.pendingTurn;
}

export function serializeLab(byProject: Record<string, LabThread>, now: number): string | null {
  const entries = Object.entries(byProject)
    .filter(([, t]) => worthKeeping(t))
    .map(([k, t]) => [k, trimThread(t)] as const)
    .slice(-MAX_PROJECTS);
  if (entries.length === 0) return null;

  const payload: PersistedLab = { v: SCHEMA_VERSION, byProject: Object.fromEntries(entries), savedAt: now };
  let raw = JSON.stringify(payload);
  // Todavía muy grande: se recorta más fuerte antes de rendirse. Perder los
  // mensajes viejos es mejor que no guardar nada.
  for (const cap of [30, 12, 4]) {
    if (raw.length <= MAX_BYTES) break;
    payload.byProject = Object.fromEntries(
      Object.entries(payload.byProject).map(([k, t]) => [k, trimThread(t, cap)]),
    );
    raw = JSON.stringify(payload);
  }
  return raw.length <= MAX_BYTES ? raw : null;
}

function isMessage(m: unknown): m is LabMessage {
  if (!m || typeof m !== "object") return false;
  const c = m as LabMessage;
  return (
    typeof c.id === "number" &&
    (c.role === "user" || c.role === "assistant") &&
    typeof c.content === "string"
  );
}

function isPendingTurn(p: unknown): p is PendingLabTurn {
  if (!p || typeof p !== "object") return false;
  const c = p as PendingLabTurn;
  return typeof c.id === "string" && c.id.length > 0 && typeof c.seq === "number";
}

/**
 * Lee lo guardado. Cualquier cosa rara —JSON roto, versión vieja, demasiado
 * viejo, forma inesperada— devuelve null: arrancar limpio es aceptable,
 * romperse al arrancar no.
 */
export function parseLab(raw: string | null, now: number): Record<string, LabThread> | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedLab;
    if (!data || data.v !== SCHEMA_VERSION || typeof data.byProject !== "object") return null;
    if (typeof data.savedAt === "number" && now - data.savedAt > MAX_AGE_MS) return null;
    const out: Record<string, LabThread> = {};
    for (const [k, t] of Object.entries(data.byProject)) {
      if (!t || !Array.isArray(t.messages) || !t.messages.every(isMessage)) continue;
      out[k] = {
        sdkSessionId: typeof t.sdkSessionId === "string" ? t.sdkSessionId : null,
        sessionKey: typeof t.sessionKey === "string" ? t.sessionKey : "",
        messages: t.messages,
        draft: typeof t.draft === "string" ? t.draft : "",
        model: typeof t.model === "string" ? t.model : null,
        pendingTurn: isPendingTurn(t.pendingTurn) ? t.pendingTurn : undefined,
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── Acceso a localStorage ──────────────────────────────────────────────
// Todo envuelto: en modo privado de Safari el simple acceso puede lanzar, y
// eso no puede tumbar el laboratorio.

export function loadLab(now = Date.now()): Record<string, LabThread> | null {
  try {
    return parseLab(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function saveLab(byProject: Record<string, LabThread>, now = Date.now()): void {
  try {
    const raw = serializeLab(byProject, now);
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Cuota llena o storage bloqueado: se sigue sin persistencia antes que
    // reventar el laboratorio.
  }
}
