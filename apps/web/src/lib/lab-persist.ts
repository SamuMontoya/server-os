/**
 * Los hilos de /laboratorio, guardados en el navegador.
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
 *
 * v2: antes había UN hilo por proyecto (`byProject: Record<projKey, LabThread>`).
 * Samu pidió poder tener VARIOS chats abiertos a la vez por proyecto, cada uno
 * con su turno corriendo en paralelo (igual que los tabs de ChatPanel), más
 * poder borrarlos desde una pantalla de lista con swipe. Eso exige un id
 * propio por hilo — ya no basta la clave del proyecto — así que el mapa pasa
 * a `byChat: Record<chatStorageKey, LabThread>` (clave `"${project}::${chatId}"`)
 * más `activeByProject` para recordar cuál de los chats de cada proyecto es
 * el que se retoma al volver.
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
  /** Documentos que se indexaron al vuelo con este mensaje (solo usuario):
   *  el archivo original nunca se guardó, así que acá no hay url que
   *  mostrar — solo el resumen (nombre, fragmentos) para la card de la
   *  burbuja. A diferencia de `images`, esto SÍ sobrevive el recorte de
   *  `trimMessage` (no depende de object URLs). */
  docs?: { name: string; chunks: number; truncated?: boolean }[];
};

/** Turno del motor que este hilo dejó corriendo (agent/chat-turns.ts). */
export interface PendingLabTurn {
  id: string;
  /** Último `seq` que el cliente alcanzó a ver: el cursor del replay. */
  seq: number;
}

/** Un chat del Laboratorio: una conversación con su propio turno en vuelo. */
export interface LabThread {
  /** Id propio del chat (uuid), estable mientras exista. */
  id: string;
  /** Nombre corto (2-3 palabras) generado por haiku con el PRIMER mensaje —
   *  ver agent/chat-title.ts. Ausente = todavía no llegó (o falló): la lista
   *  cae al recorte del primer mensaje. Se calcula UNA vez por chat: el
   *  título no debe bailar mientras la conversación avanza. */
  title?: string;
  /** Última vez que este chat recibió actividad — ordena la lista y decide
   *  qué se recorta primero cuando hay que liberar cuota. */
  updatedAt: number;
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
  /** Última vez que Samu ABRIÓ este chat de verdad (no solo que recibió
   *  actividad — eso es `updatedAt`). Decide si la lista lo marca "sin leer"
   *  (pedido de Samu 2026-09-07: antes CUALQUIER chat en reposo llevaba fondo
   *  gris, y debía ser solo el que tiene cambios sin ver). `undefined` = chat
   *  de antes de que existiera este campo, o nunca abierto tras cambiar —
   *  se trata como "leído" (no se marca sin leer de la nada al desplegar
   *  esto: solo mejores nuevos "no leído" a partir de aquí, ver
   *  `listChatsForProject`). Solo local (no viaja al servidor / otro
   *  dispositivo): es una anotación de ESTE navegador, no un dato del chat. */
  seenAt?: number;
}

/** Estado completo del laboratorio: todos los chats + cuál está activo por proyecto. */
export interface PersistedLab {
  v: number;
  /** clave = `chatStorageKey(project, chat.id)`. */
  byChat: Record<string, LabThread>;
  /** projectKey ("general" o el slug) → id del chat que se retoma al volver. */
  activeByProject: Record<string, string>;
  savedAt: number;
}

/** Forma en memoria que usa laboratorio/page.tsx tras hidratar. */
export interface HydratedLab {
  byChat: Record<string, LabThread>;
  activeByProject: Record<string, string>;
}

export const STORAGE_KEY = "hermes_os_lab_chat";
/** Subir esto invalida lo guardado (cambio de forma incompatible). */
export const SCHEMA_VERSION = 3;

export function chatStorageKey(project: string, chatId: string): string {
  return `${project}::${chatId}`;
}

// ── Recortes ───────────────────────────────────────────────────────────
/** Techo GLOBAL de chats retenidos (antes era por proyecto: con varios chats
 *  por proyecto el límite que importa es el total, no cuántos proyectos hay). */
const MAX_CHATS = 40;
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

export function serializeLab(
  byChat: Record<string, LabThread>,
  activeByProject: Record<string, string>,
  now: number,
): string | null {
  // Los chats activos (los que se retoman al volver) nunca se descartan por
  // cuota aunque sean los más viejos: perder EL que se está viendo ahora
  // mismo sería mucho peor que perder uno archivado de hace días.
  const activeIds = new Set(Object.values(activeByProject));
  const entries = Object.entries(byChat)
    .filter(([, t]) => worthKeeping(t))
    .map(([k, t]) => [k, trimThread(t)] as const)
    .sort((a, b) => {
      const aActive = activeIds.has(a[1].id) ? 1 : 0;
      const bActive = activeIds.has(b[1].id) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive; // activos primero
      return b[1].updatedAt - a[1].updatedAt; // luego los más recientes
    })
    .slice(0, MAX_CHATS);
  if (entries.length === 0) return null;

  const keptIds = new Set(entries.map(([, t]) => t.id));
  const prunedActive = Object.fromEntries(
    Object.entries(activeByProject).filter(([, id]) => keptIds.has(id)),
  );

  const payload: PersistedLab = {
    v: SCHEMA_VERSION,
    byChat: Object.fromEntries(entries),
    activeByProject: prunedActive,
    savedAt: now,
  };
  let raw = JSON.stringify(payload);
  // Todavía muy grande: se recorta más fuerte antes de rendirse. Perder los
  // mensajes viejos es mejor que no guardar nada.
  for (const cap of [30, 12, 4]) {
    if (raw.length <= MAX_BYTES) break;
    payload.byChat = Object.fromEntries(
      Object.entries(payload.byChat).map(([k, t]) => [k, trimThread(t, cap)]),
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
export function parseLab(raw: string | null, now: number): HydratedLab | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedLab;
    if (!data || data.v !== SCHEMA_VERSION || typeof data.byChat !== "object") return null;
    if (typeof data.savedAt === "number" && now - data.savedAt > MAX_AGE_MS) return null;
    const byChat: Record<string, LabThread> = {};
    for (const [k, t] of Object.entries(data.byChat)) {
      if (!t || typeof t.id !== "string" || !t.id) continue;
      if (!Array.isArray(t.messages) || !t.messages.every(isMessage)) continue;
      byChat[k] = {
        id: t.id,
        ...(typeof t.title === "string" && t.title.trim() ? { title: t.title } : {}),
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
        sdkSessionId: typeof t.sdkSessionId === "string" ? t.sdkSessionId : null,
        sessionKey: typeof t.sessionKey === "string" ? t.sessionKey : "",
        messages: t.messages,
        draft: typeof t.draft === "string" ? t.draft : "",
        model: typeof t.model === "string" ? t.model : null,
        pendingTurn: isPendingTurn(t.pendingTurn) ? t.pendingTurn : undefined,
        seenAt: typeof t.seenAt === "number" ? t.seenAt : undefined,
      };
    }
    if (Object.keys(byChat).length === 0) return null;
    const activeByProject: Record<string, string> = {};
    if (data.activeByProject && typeof data.activeByProject === "object") {
      for (const [proj, id] of Object.entries(data.activeByProject)) {
        if (typeof id === "string" && id) activeByProject[proj] = id;
      }
    }
    return { byChat, activeByProject };
  } catch {
    return null;
  }
}

// ── Acceso a localStorage ──────────────────────────────────────────────
// Todo envuelto: en modo privado de Safari el simple acceso puede lanzar, y
// eso no puede tumbar el laboratorio.

export function loadLab(now = Date.now()): HydratedLab | null {
  try {
    return parseLab(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function saveLab(
  byChat: Record<string, LabThread>,
  activeByProject: Record<string, string>,
  now = Date.now(),
): void {
  try {
    const raw = serializeLab(byChat, activeByProject, now);
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Cuota llena o storage bloqueado: se sigue sin persistencia antes que
    // reventar el laboratorio.
  }
}
