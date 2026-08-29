import "../env.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Modo de bajo consumo.
 *
 * El plan no se mide en dólares sino en ventanas de uso: una de 5 h (la
 * "sesión") y varias semanales. Anthropic las expone en el endpoint privado
 * `/api/oauth/usage` como `utilization` 0-100 — el mismo que alimenta el widget
 * del dashboard. Aquí se lee desde el AGENTE, para que la decisión no dependa
 * de que la web esté arriba (el loop nocturno corre sin nadie mirando).
 *
 * Qué hace el modo bajo, y por qué cada cosa (la idea es máximo rendimiento por
 * token, no "responder peor"):
 *
 *  - Techo de nivel: el router no pasa de `standard`. El trabajo duro se sigue
 *    haciendo, en sonnet en vez de opus.
 *  - Esfuerzo `low`: es la primera palanca que canjea calidad por gasto dentro
 *    de un mismo modelo, y en tareas rutinarias casi no se nota.
 *  - Menos turnos: un techo bajo corta la exploración perezosa, que es donde se
 *    va el gasto cuando el modelo "da vueltas".
 *  - Retrieval mínimo: el prompt precarga memorias y conocimiento en CADA turno
 *    se usen o no. En modo bajo se precarga poco y el agente amplía con
 *    search_knowledge SOLO si lo necesita. Es la diferencia entre pagar por
 *    contexto especulativo y pagar por contexto pedido.
 *  - Subagentes forzados: lo mecánico se va a haiku en su propio contexto.
 */

export type PowerMode = "normal" | "low";

export interface BudgetState {
  mode: PowerMode;
  /** 0-100 de la ventana de 5 h; null si no se pudo leer. */
  sessionUtilization: number | null;
  reason: string;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Umbral por defecto: a partir de aquí se baja el consumo. */
const DEFAULT_THRESHOLD = 70;
// El endpoint tiene rate limit propio: consultarlo por turno lo tumbaría.
const TTL_MS = 5 * 60_000;
const TTL_FAIL_MS = 15 * 60_000;

let cache: { at: number; ttl: number; state: BudgetState } | null = null;

function threshold(): number {
  const n = Number(process.env.HERMES_LOW_POWER_AT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_THRESHOLD;
}

/**
 * Ventana nocturna `HERMES_LOW_POWER_HOURS=23-7` (hora local). Pensada para el
 * loop desatendido: de noche nadie está esperando la respuesta, así que la
 * calidad marginal no vale lo que cuesta.
 */
function inNightWindow(now = new Date()): boolean {
  const raw = (process.env.HERMES_LOW_POWER_HOURS || "").trim();
  if (!raw) return false;
  const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) {
    console.warn(`[budget] HERMES_LOW_POWER_HOURS="${raw}" inválido (formato: 23-7)`);
    return false;
  }
  const [from, to] = [Number(m[1]), Number(m[2])];
  const h = now.getHours();
  // Una ventana que cruza medianoche (23-7) no es un rango normal: es la unión
  // de [23,24) y [0,7). Compararla con from<=h<to daría siempre false.
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

async function readToken(): Promise<string | null> {
  const env = (process.env.CLAUDE_OAUTH_TOKEN || "").trim();
  if (env) return env;
  // Mismo archivo que usa el dashboard: una sola fuente para las dos apps.
  try {
    const t = (await readFile(join(homedir(), ".hermes-os", "claude-token"), "utf8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

async function fetchUtilization(): Promise<number | null> {
  const token = await readToken();
  if (!token) return null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-cli (external, server-os)",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { five_hour?: { utilization?: unknown } };
    const u = Number(json.five_hour?.utilization);
    return Number.isFinite(u) ? Math.max(0, Math.min(100, u)) : null;
  } catch {
    return null;
  }
}

/**
 * Estado actual. Cachea porque el endpoint limita, y **falla hacia `normal`**:
 * si no se puede leer el uso, degradar la calidad a ciegas sería peor que
 * gastar de más. El modo forzado y la ventana nocturna no dependen de la red.
 */
export async function budgetState(): Promise<BudgetState> {
  const forced = (process.env.HERMES_LOW_POWER || "").toLowerCase();
  if (forced === "1" || forced === "on")
    return { mode: "low", sessionUtilization: null, reason: "forzado por HERMES_LOW_POWER" };
  if (forced === "off")
    return { mode: "normal", sessionUtilization: null, reason: "desactivado por HERMES_LOW_POWER=off" };

  if (inNightWindow())
    return {
      mode: "low",
      sessionUtilization: null,
      reason: `ventana nocturna (${process.env.HERMES_LOW_POWER_HOURS})`,
    };

  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.state;

  const util = await fetchUtilization();
  const state: BudgetState =
    util === null
      ? { mode: "normal", sessionUtilization: null, reason: "uso no disponible — se asume normal" }
      : util >= threshold()
        ? { mode: "low", sessionUtilization: util, reason: `sesión al ${util}% (umbral ${threshold()}%)` }
        : { mode: "normal", sessionUtilization: util, reason: `sesión al ${util}%` };

  cache = { at: now, ttl: util === null ? TTL_FAIL_MS : TTL_MS, state };
  return state;
}

/** Perfil de ejecución que aplica cada modo. Un solo sitio para los números. */
export interface PowerProfile {
  /** El router no puede superar este nivel. */
  maxTier: "light" | "standard" | "deep";
  /** Esfuerzo máximo permitido. */
  maxEffort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  /** Cuánto contexto se PRECARGA en el prompt (lo demás lo pide el agente). */
  retrieval: { recent: number; relevant: number; chars: number };
  /** En modo bajo los subagentes dejan de ser opcionales. */
  forceSubagents: boolean;
}

export const PROFILES: Record<PowerMode, PowerProfile> = {
  normal: {
    maxTier: "deep",
    maxEffort: "xhigh",
    maxTurns: 40,
    retrieval: { recent: 5, relevant: 8, chars: 300 },
    forceSubagents: false,
  },
  low: {
    maxTier: "standard",
    maxEffort: "low",
    maxTurns: 15,
    // ~975 tokens de precarga por turno bajan a ~200. El agente sigue teniendo
    // search_knowledge para traer lo que de verdad necesite.
    retrieval: { recent: 2, relevant: 3, chars: 160 },
    forceSubagents: true,
  },
};

export async function currentProfile(): Promise<PowerProfile & { mode: PowerMode; reason: string }> {
  const s = await budgetState();
  return { ...PROFILES[s.mode], mode: s.mode, reason: s.reason };
}
