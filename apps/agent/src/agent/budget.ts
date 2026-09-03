import "../env.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Modo de consumo, en TRES escalones — no es un interruptor, es una rampa.
 *
 * El plan no se mide en dólares sino en ventanas de uso: una de 5 h (la
 * "sesión") y varias semanales. Anthropic las expone en el endpoint privado
 * `/api/oauth/usage` como `utilization` 0-100 — el mismo que alimenta el widget
 * del dashboard. Aquí se lee desde el AGENTE, para que la decisión no dependa
 * de que la web esté arriba (el loop desatendido corre sin nadie mirando).
 *
 * Los tres escalones:
 *
 *  - `normal` (0-70%): rango completo del router, sin techo.
 *  - `bajo` (70-90%): techo en `bajo` (sonnet, esfuerzo low). Lo que el router
 *    ya clasificaba como trivial se queda en haiku sin cambios — el techo solo
 *    tira hacia abajo lo que iba a `medio`/`alto`. Mismo modelo, mismas
 *    capacidades, más barato: la idea es prolongar la ventana, no responder
 *    peor.
 *  - `critico` (90%+): techo en `trivial` (solo haiku). Aquí sí se nota: es la
 *    última reserva antes de quedarse sin ventana, y session.ts se lo dice al
 *    usuario en vez de intentar una tarea compleja con una fracción de la
 *    capacidad que necesita.
 *
 * Se activa por umbral automáticamente, o a mano con HERMES_LOW_POWER=1
 * (fuerza `bajo`) — nunca por horario.
 *
 * El resto de palancas del modo restringido (aparte del techo de nivel):
 *  - Menos turnos: un techo bajo corta la exploración perezosa, que es donde se
 *    va el gasto cuando el modelo "da vueltas".
 *  - Retrieval mínimo: el prompt precarga memorias y conocimiento en CADA turno
 *    se usen o no. En modo restringido se precarga poco y el agente amplía con
 *    search_knowledge SOLO si lo necesita. Es la diferencia entre pagar por
 *    contexto especulativo y pagar por contexto pedido.
 *  - Subagentes forzados: lo mecánico se va a haiku en su propio contexto.
 */

export type PowerMode = "normal" | "bajo" | "critico";

export interface BudgetState {
  mode: PowerMode;
  /** 0-100 de la ventana de 5 h; null si no se pudo leer. */
  sessionUtilization: number | null;
  reason: string;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Umbrales por defecto de los dos escalones (0-100). */
const DEFAULT_THRESHOLD_BAJO = 70;
const DEFAULT_THRESHOLD_CRITICO = 90;
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

function thresholdBajo(): number {
  const n = Number(process.env.HERMES_LOW_POWER_AT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_THRESHOLD_BAJO;
}

function thresholdCritico(): number {
  const n = Number(process.env.HERMES_CRITICAL_AT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_THRESHOLD_CRITICO;
}

async function readToken(): Promise<string | null> {
  // Override explícito, si alguien quiere aislar este lector.
  const fromEnv = (process.env.CLAUDE_OAUTH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  // Se reusa la credencial del PROPIO CLI: es el mismo token OAuth con el que
  // ya infiere y sirve tal cual contra /api/oauth/usage. Pedir un archivo
  // aparte era trabajo inventado. En Linux (el servidor) no hay Keychain: el
  // archivo ES la fuente, sin fallback.
  const readers: (() => Promise<string | null>)[] = [];
  const fromFile = async () => {
    try {
      const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      return typeof tok === "string" && tok ? tok : null;
    } catch {
      return null;
    }
  };
  readers.push(fromFile);

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
    return { mode: "bajo", sessionUtilization: null, reason: "forzado por HERMES_LOW_POWER" };
  if (forced === "off")
    return { mode: "normal", sessionUtilization: null, reason: "desactivado por HERMES_LOW_POWER=off" };


  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.state;

  const util = await fetchUtilization();
  const state: BudgetState =
    util === null
      ? { mode: "normal", sessionUtilization: null, reason: "uso no disponible — se asume normal" }
      : util >= thresholdCritico()
        ? { mode: "critico", sessionUtilization: util, reason: `sesión al ${util}% (umbral crítico ${thresholdCritico()}%)` }
        : util >= thresholdBajo()
          ? { mode: "bajo", sessionUtilization: util, reason: `sesión al ${util}% (umbral ${thresholdBajo()}%)` }
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
  maxTier: "trivial" | "bajo" | "medio" | "alto";
  /** Esfuerzo máximo permitido (para sonnet; haiku no lo usa). */
  maxEffort: "low" | "medium" | "high";
  maxTurns: number;
  /** Cuánto contexto se PRECARGA en el prompt (lo demás lo pide el agente). */
  retrieval: { recent: number; relevant: number; chars: number };
  /** Fuera de `normal` los subagentes dejan de ser opcionales. */
  forceSubagents: boolean;
}

export const PROFILES: Record<PowerMode, PowerProfile> = {
  normal: {
    maxTier: "alto",
    maxEffort: "high",
    // Sin techo real: se combina con TIERS[tier].maxTurns por Math.min (ver
    // session.ts), así que este número solo importa si es MENOR al de algún
    // nivel — 44 iguala el techo de `alto` (el más alto que existe) para que
    // "modo normal" de verdad no recorte nada. Subir `alto` sin subir esto
    // sería un bug silencioso: el Math.min lo taparía de vuelta al valor
    // viejo sin ningún error visible.
    maxTurns: 44,
    retrieval: { recent: 5, relevant: 8, chars: 300 },
    forceSubagents: false,
  },
  bajo: {
    // Sonnet con esfuerzo bajo, no haiku: mismas capacidades, más barato. Ver
    // el comentario grande de arriba — el router ya manda lo trivial a haiku
    // por su cuenta, este techo solo tira hacia abajo lo que iba a costar más.
    maxTier: "bajo",
    maxEffort: "low",
    maxTurns: 15,
    // ~975 tokens de precarga por turno bajan a ~200. El agente sigue teniendo
    // search_knowledge para traer lo que de verdad necesite.
    retrieval: { recent: 2, relevant: 3, chars: 160 },
    forceSubagents: true,
  },
  critico: {
    // Última reserva antes de quedarse sin ventana: SOLO haiku. session.ts
    // detecta cuándo esto degradó un pedido que pedía más y lo dice, en vez de
    // intentar una tarea compleja con una fracción de la capacidad que
    // necesita — eso sale peor que negarse y esperar el reset.
    maxTier: "trivial",
    maxEffort: "low",
    maxTurns: 8,
    retrieval: { recent: 1, relevant: 2, chars: 120 },
    forceSubagents: true,
  },
};

export async function currentProfile(): Promise<PowerProfile & { mode: PowerMode; reason: string }> {
  const s = await budgetState();
  return { ...PROFILES[s.mode], mode: s.mode, reason: s.reason };
}
