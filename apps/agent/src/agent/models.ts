// Importar env.js aunque no se use su export: es quien corre dotenv. Sin esto
// el módulo depende de que ALGUIEN más lo haya importado antes, y leer
// HERMES_DISABLED/HERMES_MODEL da vacío según el orden de imports.
import "../env.js";
import { isEnabled } from "@hermes/shared";

/**
 * Política de modelos y esfuerzo, en UN solo sitio.
 *
 * Antes los 11 call sites del Agent SDK pasaban todos `HERMES_MODEL || undefined`:
 * el mismo modelo para generar tres variantes de un hook que para editar video
 * con 300 turnos. Aquí cada rol declara qué necesita y el `.env` puede pisarlo.
 *
 * La regla de oro del tuneo de costo NO es "usa el modelo más barato": es medir
 * el costo por TAREA COMPLETADA. Un modelo barato que necesita tres intentos y
 * más turnos sale más caro que uno bueno que acierta a la primera. Por eso los
 * roles agénticos (consola, edición) se quedan en la gama alta y solo bajan los
 * roles de una pasada con salida estructurada, donde el trabajo real lo hace el
 * schema y no el razonamiento.
 *
 * Ojo con el caché: es por modelo. Repartir un mismo flujo entre modelos tira
 * el prefijo cacheado en cada salto, así que dividir de más puede COSTAR más.
 * Por eso el corte va por rol (procesos distintos), no dentro de un turno.
 */

/** Alias del CLI. Se usan alias y no IDs con fecha: el CLI los resuelve. */
export type ModelAlias = "opus" | "sonnet" | "haiku";

/** Niveles que acepta el SDK. Haiku 4.5 NO soporta effort — ver `optionsFor`. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Role =
  | "console" // agente principal de la consola (hasta 40 turnos, tools reales)
  | "run" // ejecuciones de código headless
  | "videoEdit" // OpenMontage: 300 turnos, largo horizonte
  | "analyst" // resumen de una ejecución terminada
  | "meetingIngest" // transcripción → acta estructurada
  | "pieceChat" // chat de una pieza, 2 tools acotadas
  | "contentKit" // guion + hook + plan de tomas
  | "variants" // 3-5 variantes de un hook
  | "englishReport" // análisis de una sesión de inglés
  | "liveCopilot" // sugerencia en vivo, presupuesto ~2s
  | "liveCoach"; // métricas de junta cada 20-45s

type Policy = { model: ModelAlias; effort?: Effort };

/**
 * Por qué cada uno:
 *  - console/run/videoEdit: agénticos y de muchos turnos. Aquí es donde un
 *    modelo flojo se vuelve CARO — repite, se equivoca y gasta más turnos.
 *  - videoEdit va a xhigh: es la recomendación para trabajo agéntico largo, y
 *    300 turnos mal encaminados cuestan mucho más que el esfuerzo extra.
 *  - analyst/variants/liveCopilot/liveCoach: una pasada, salida forzada por una
 *    tool con schema. El modelo no tiene que razonar, tiene que rellenar.
 *  - liveCopilot y liveCoach además son sensibles a LATENCIA: haiku responde
 *    en ~2s, que es el presupuesto real de una sugerencia en vivo.
 */
const DEFAULTS: Record<Role, Policy> = {
  console: { model: "opus", effort: "high" },
  run: { model: "opus", effort: "high" },
  videoEdit: { model: "opus", effort: "xhigh" },
  analyst: { model: "haiku" },
  meetingIngest: { model: "sonnet", effort: "medium" },
  pieceChat: { model: "sonnet", effort: "medium" },
  contentKit: { model: "sonnet", effort: "high" },
  variants: { model: "haiku" },
  englishReport: { model: "sonnet", effort: "medium" },
  liveCopilot: { model: "haiku" },
  liveCoach: { model: "haiku" },
};

// Haiku 4.5 devuelve error si le mandas `effort`. Se filtra aquí y no en cada
// call site, que es donde se olvidaría.
const SUPPORTS_EFFORT: Record<ModelAlias, boolean> = {
  opus: true,
  sonnet: true,
  haiku: false,
};

const ALIASES = new Set<ModelAlias>(["opus", "sonnet", "haiku"]);
const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * Override por rol: `HERMES_MODEL_CONSOLE=sonnet:low`. El modelo global
 * `HERMES_MODEL` sigue funcionando como piso para todos los roles (compatible
 * con lo que ya había), y el override por rol le gana.
 */
function envOverride(role: Role): Policy | null {
  const key = `HERMES_MODEL_${role.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
  const raw = (process.env[key] || "").trim().toLowerCase();
  if (!raw) return null;
  const [m, e] = raw.split(":");
  if (!ALIASES.has(m as ModelAlias)) {
    console.warn(`[models] ${key}="${raw}": "${m}" no es un alias válido — se ignora`);
    return null;
  }
  const effort = e && EFFORTS.has(e as Effort) ? (e as Effort) : undefined;
  if (e && !effort) console.warn(`[models] ${key}: esfuerzo "${e}" inválido — se usa el default`);
  return { model: m as ModelAlias, effort };
}

export function policyFor(role: Role): Policy {
  const override = envOverride(role);
  if (override) return override;
  const global = (process.env.HERMES_MODEL || "").trim().toLowerCase();
  if (global && ALIASES.has(global as ModelAlias)) {
    // Un HERMES_MODEL global fija el modelo pero respeta el esfuerzo del rol:
    // "quiero todo en sonnet" no debería además aplanar el esfuerzo.
    return { model: global as ModelAlias, effort: DEFAULTS[role].effort };
  }
  return DEFAULTS[role];
}

/**
 * Opciones listas para `query()`. Devuelve solo las claves que aplican: mandar
 * `effort: undefined` a un modelo que no lo soporta es lo mismo que no mandarlo,
 * pero mandarlo con valor a haiku es un 400.
 */
export function optionsFor(role: Role): { model: string; effort?: Effort } {
  const p = policyFor(role);
  const out: { model: string; effort?: Effort } = { model: p.model };
  if (p.effort && SUPPORTS_EFFORT[p.model]) out.effort = p.effort;
  return out;
}

/** Para el log de arranque: la tabla efectiva, sin tener que leer el .env. */
export function modelSummary(): string {
  const roles = Object.keys(DEFAULTS) as Role[];
  return roles
    .filter((r) => {
      // No se listan roles de features apagadas: ruido puro.
      if (r === "videoEdit" || r === "contentKit" || r === "variants" || r === "pieceChat")
        return isEnabled("estudio");
      if (r === "meetingIngest" || r === "liveCopilot" || r === "liveCoach")
        return isEnabled("juntas");
      if (r === "englishReport") return isEnabled("ingles");
      return true;
    })
    .map((r) => {
      const p = policyFor(r);
      return `${r}=${p.model}${p.effort && SUPPORTS_EFFORT[p.model] ? `/${p.effort}` : ""}`;
    })
    .join(" ");
}
