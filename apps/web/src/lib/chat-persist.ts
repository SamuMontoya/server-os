/**
 * El hilo de la consola, guardado en el navegador.
 *
 * Antes los tabs vivían SOLO en `useState`. En el escritorio no se notaba,
 * pero un dashboard abierto desde el iPhone es otra cosa: iOS congela y acaba
 * matando la pestaña en segundo plano, así que bloquear la pantalla y volver
 * remontaba el componente desde cero y aparecía un chat nuevo, vacío, como si
 * nunca hubieras hablado. La conversación seguía en el servidor; lo que se
 * perdía era la pantalla.
 *
 * Este módulo es puro a propósito (nada de React ni de red): es la parte con
 * reglas —qué se recorta, en qué orden, qué se descarta— y por eso es la parte
 * que tiene tests.
 */
import type { ChatToolStep } from "@hermes/shared";
// Solo el tipo: así este módulo no arrastra nada del browser y se puede
// testear con node a secas.
import type { ChatMessage } from "@/lib/hermes";

/** Turno del motor que este tab dejó corriendo (agent/chat-turns.ts). */
export interface PendingTurn {
  id: string;
  /** Último `seq` que el cliente alcanzó a ver: el cursor del replay. */
  seq: number;
}

export interface ChatTab {
  /** id del tab; también viaja como X-Hermes-Session-Id (clave por tab). */
  key: string;
  /** sesión SDK que este tab resume (uuid del jsonl); null = aún sin crear. */
  sdkSessionId: string | null;
  title: string;
  messages: ChatMessage[];
  /**
   * Pasos agénticos por índice de mensaje del asistente. Van APARTE de
   * `messages` a propósito: el historial que se manda al agente es solo
   * role/content — los pasos son presentación del turno en vivo.
   */
  steps: Record<number, ChatToolStep[]>;
  draft: string;
  busy: boolean;
  /**
   * Turno en vuelo. Se persiste: es lo que permite volver horas después y
   * re-engancharse en vez de ver un hilo cortado a media respuesta.
   */
  pendingTurn?: PendingTurn;
  /** El servidor está reintentando: se muestra en vez de un "pensando" mudo. */
  retryAttempt?: number;
  /** Se perdió la conexión con el turno (que sigue vivo del otro lado). */
  stalled?: boolean;
}

export interface TabsState {
  tabs: ChatTab[];
  active: string;
}

/** Estado completo de la consola: los tabs de cada proyecto en foco. */
export interface PersistedChat {
  v: number;
  /** projectKey ("general" o el slug) → sus tabs. */
  byProject: Record<string, TabsState>;
  savedAt: number;
}

export const STORAGE_KEY = "hermes_os_chat_tabs";
/** Subir esto invalida lo guardado (cambio de forma incompatible). */
export const SCHEMA_VERSION = 1;

// ── Recortes ───────────────────────────────────────────────────────────
// localStorage da ~5 MB por origen y escribir de más TIRA (QuotaExceeded), así
// que el recorte es parte del contrato, no una optimización.
const MAX_PROJECTS = 6;
const MAX_TABS_PER_PROJECT = 8;
const MAX_MESSAGES_PER_TAB = 60;
/** Un mensaje larguísimo (un volcado de logs) no puede llevarse la cuota. */
const MAX_CHARS_PER_MESSAGE = 12_000;
/** Techo duro del blob. Por encima se recorta más y se reintenta. */
const MAX_BYTES = 900_000;
/** Días sin tocar un proyecto → no vale la pena rehidratarlo. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function trimMessage(m: ChatMessage): ChatMessage {
  if (m.content.length <= MAX_CHARS_PER_MESSAGE) return m;
  return { ...m, content: `${m.content.slice(0, MAX_CHARS_PER_MESSAGE)}\n\n[…recortado]` };
}

/**
 * Deja el tab en tamaño de guardado. `busy` NUNCA se persiste como true: al
 * rehidratar, quien decide si hay algo corriendo es el turno pendiente
 * (verificable contra el servidor), no un booleano viejo — un `busy` fósil
 * dejaba el composer bloqueado para siempre.
 */
export function trimTab(tab: ChatTab, maxMessages = MAX_MESSAGES_PER_TAB): ChatTab {
  const dropped = Math.max(0, tab.messages.length - maxMessages);
  const messages = tab.messages.slice(-maxMessages).map(trimMessage);
  // Los pasos se indexan por posición del mensaje: al recortar por delante hay
  // que correr las claves o quedan apuntando al mensaje equivocado.
  const steps: Record<number, ChatToolStep[]> = {};
  for (const [k, v] of Object.entries(tab.steps)) {
    const idx = Number(k) - dropped;
    if (idx >= 0) steps[idx] = v;
  }
  return { ...tab, messages, steps, busy: false };
}

/** Nada que guardar: un tab virgen no merece ocupar cuota. */
function worthKeeping(tab: ChatTab): boolean {
  return tab.messages.length > 0 || tab.draft.trim().length > 0 || !!tab.pendingTurn;
}

export function serializeChat(
  byProject: Record<string, TabsState>,
  now: number,
): string | null {
  const entries = Object.entries(byProject)
    .map(([project, state]) => {
      const tabs = state.tabs.filter(worthKeeping).slice(-MAX_TABS_PER_PROJECT).map((t) => trimTab(t));
      // Si el tab activo se cayó del recorte, manda el último que quedó.
      const active = tabs.some((t) => t.key === state.active)
        ? state.active
        : (tabs[tabs.length - 1]?.key ?? state.active);
      return [project, { tabs, active }] as const;
    })
    .filter(([, state]) => state.tabs.length > 0)
    .slice(-MAX_PROJECTS);
  if (entries.length === 0) return null;

  const payload: PersistedChat = {
    v: SCHEMA_VERSION,
    byProject: Object.fromEntries(entries),
    savedAt: now,
  };
  let raw = JSON.stringify(payload);
  // Todavía muy grande: se recorta más fuerte antes de rendirse. Perder los
  // mensajes viejos es mejor que no guardar nada.
  for (const cap of [30, 12, 4]) {
    if (raw.length <= MAX_BYTES) break;
    payload.byProject = Object.fromEntries(
      Object.entries(payload.byProject).map(([project, state]) => [
        project,
        { ...state, tabs: state.tabs.map((t) => trimTab(t, cap)) },
      ]),
    );
    raw = JSON.stringify(payload);
  }
  return raw.length <= MAX_BYTES ? raw : null;
}

/**
 * Lee lo guardado. Cualquier cosa rara —JSON roto, versión vieja, demasiado
 * viejo, forma inesperada— devuelve null: arrancar limpio es aceptable,
 * romperse al arrancar no.
 */
export function parseChat(raw: string | null, now: number): Record<string, TabsState> | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedChat;
    if (!data || data.v !== SCHEMA_VERSION || typeof data.byProject !== "object") return null;
    if (typeof data.savedAt === "number" && now - data.savedAt > MAX_AGE_MS) return null;
    const out: Record<string, TabsState> = {};
    for (const [project, state] of Object.entries(data.byProject)) {
      if (!state || !Array.isArray(state.tabs)) continue;
      const tabs = state.tabs.filter(isTab).map((t) => ({
        ...t,
        // Se rehidrata SIEMPRE libre: si había un turno corriendo, el cliente
        // lo confirma contra el servidor y ahí sí vuelve a marcar ocupado.
        busy: false,
        retryAttempt: undefined,
        stalled: false,
        steps: t.steps && typeof t.steps === "object" ? t.steps : {},
        draft: typeof t.draft === "string" ? t.draft : "",
      }));
      if (tabs.length === 0) continue;
      const active = tabs.some((t) => t.key === state.active)
        ? state.active
        : tabs[tabs.length - 1].key;
      out[project] = { tabs, active };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function isTab(t: unknown): t is ChatTab {
  if (!t || typeof t !== "object") return false;
  const c = t as ChatTab;
  return (
    typeof c.key === "string" &&
    c.key.length > 0 &&
    Array.isArray(c.messages) &&
    c.messages.every(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
  );
}

// ── Acceso a localStorage ──────────────────────────────────────────────
// Todo envuelto: en modo privado de Safari el simple acceso puede lanzar, y
// eso no puede tumbar la consola.

export function loadChat(now = Date.now()): Record<string, TabsState> | null {
  try {
    return parseChat(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function saveChat(byProject: Record<string, TabsState>, now = Date.now()): void {
  try {
    const raw = serializeChat(byProject, now);
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Cuota llena o storage bloqueado: se sigue sin persistencia antes que
    // reventar el chat.
  }
}

export function clearChat(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
