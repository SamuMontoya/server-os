import "../env.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Modo de bajo consumo.
 *
 * El plan no se mide en dólares sino en ventanas de uso: una de 5 h (la
 * "sesión") y varias semanales. Anthropic las expone en el endpoint privado
 * `/api/oauth/usage` como `utilization` 0-100 — el mismo que alimenta el widget
 * del dashboard. Aquí se lee desde el AGENTE, para que la decisión no dependa
 * de que la web esté arriba (el loop desatendido corre sin nadie mirando).
 *
 * Se activa de dos formas y ninguna es por horario: automáticamente al pasar el
 * umbral de la ventana de 5 h, o a mano con HERMES_LOW_POWER=1.
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
// Los fallos se reintentan RÁPIDO al principio y se van espaciando. Con un TTL
// fijo de 15 min, el fallo típico —la primera consulta corre antes de que la
// red esté lista al arrancar— dejaba al agente 15 minutos ciego al consumo:
// si el servidor arranca con la sesión al 90%, no se enteraría. Verificado en
// el despliegue real: el arranque decía "uso no disponible" y un reinicio
// leía 15% sin problema.
const FAIL_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];

let cache: { at: number; ttl: number; state: BudgetState } | null = null;
let consecutiveFailures = 0;

function threshold(): number {
  const n = Number(process.env.HERMES_LOW_POWER_AT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_THRESHOLD;
}

async function readToken(): Promise<string | null> {
  // Override explícito, si alguien quiere aislar este lector.
  const fromEnv = (process.env.CLAUDE_OAUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  // Se reusa la credencial del PROPIO CLI: es el mismo token OAuth con el que
  // ya infiere y sirve tal cual contra /api/oauth/usage. Pedir un archivo
  // aparte era trabajo inventado.
  //
  // El ORDEN importa y depende de la plataforma: en macOS la fuente viva es el
  // Keychain y ~/.claude/.credentials.json suele ser un remanente RANCIO — si
  // se lee primero, devuelve un token vencido que da 401 y nunca se llega al
  // Keychain. En Linux (el servidor) no hay Keychain y el archivo ES la fuente.
  const readers: (() => Promise<string | null>)[] = [];
  const fromKeychain = async () => {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      const tok = JSON.parse(stdout)?.claudeAiOauth?.accessToken;
      return typeof tok === "string" && tok ? tok : null;
    } catch {
      return null;
    }
  };
  const fromFile = async () => {
    try {
      const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      return typeof tok === "string" && tok ? tok : null;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") readers.push(fromKeychain, fromFile);
  else readers.push(fromFile);

  // Archivo heredado del dashboard (compatibilidad).
  readers.push(async () => {
    try {
      const t = (await readFile(join(homedir(), ".hermes-os", "claude-token"), "utf8")).trim();
      return t || null;
    } catch {
      return null;
    }
  });

  for (const read of readers) {
    const tok = await read();
    if (tok) return tok;
  }
  return null;
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
 * gastar de más. El modo forzado no depende de la red.
 */
export async function budgetState(): Promise<BudgetState> {
  const forced = (process.env.HERMES_LOW_POWER || "").toLowerCase();
  if (forced === "1" || forced === "on")
    return { mode: "low", sessionUtilization: null, reason: "forzado por HERMES_LOW_POWER" };
  if (forced === "off")
    return { mode: "normal", sessionUtilization: null, reason: "desactivado por HERMES_LOW_POWER=off" };


  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.state;

  const util = await fetchUtilization();
  const state: BudgetState =
    util === null
      ? { mode: "normal", sessionUtilization: null, reason: "uso no disponible — se asume normal" }
      : util >= threshold()
        ? { mode: "low", sessionUtilization: util, reason: `sesión al ${util}% (umbral ${threshold()}%)` }
        : { mode: "normal", sessionUtilization: util, reason: `sesión al ${util}%` };

  if (util === null) {
    const ttl = FAIL_BACKOFF_MS[Math.min(consecutiveFailures, FAIL_BACKOFF_MS.length - 1)];
    consecutiveFailures++;
    cache = { at: now, ttl, state };
  } else {
    consecutiveFailures = 0;
    cache = { at: now, ttl: TTL_MS, state };
  }
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
