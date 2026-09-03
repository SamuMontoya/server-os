// Importar env.js aunque no se use su export: es quien corre dotenv. Sin esto
// el módulo depende de que ALGUIEN más lo haya importado antes, y leer
// HERMES_MODEL da vacío según el orden de imports.
import "../env.js";

/**
 * Política de modelos y esfuerzo, en UN solo sitio.
 *
 * Sonnet es el modelo PRINCIPAL — para todo, incluido el trabajo complejo
 * (auditorías, investigación, refactors). Opus se retiró por completo: salió
 * mucho más caro y el router (`router.ts`) ya manda el trabajo difícil a
 * sonnet con esfuerzo alto en vez de a otro modelo. Haiku queda solo para lo
 * verdaderamente trivial (saludos, confirmaciones, preguntas de estado de una
 * frase) — ver `router.ts` para el enrutamiento por esfuerzo del chat.
 *
 * Este archivo cubre los roles de UNA PASADA con salida estructurada (resumir
 * una ejecución, titular un chat) — el chat interactivo no pasa por aquí, pasa
 * por `router.ts`.
 */

/** Alias del CLI. Se usan alias y no IDs con fecha: el CLI los resuelve. */
export type ModelAlias = "sonnet" | "haiku";

/** Niveles que acepta el SDK para sonnet. Haiku NO soporta effort. */
export type Effort = "low" | "medium" | "high";

export type Role =
  | "analyst" // resumen de una ejecución terminada
  | "chatTitle" // 2-3 palabras para nombrar un chat, a partir del 1er mensaje
  | "chatGist"; // una frase para la pantalla del reloj, a partir de la respuesta

type Policy = { model: ModelAlias; effort?: Effort };

/**
 * Los tres roles que quedan son de UNA pasada con salida forzada por schema:
 * el modelo no tiene que razonar, tiene que rellenar. Haiku de sobra para los
 * tres, y además corren en paralelo al turno real (chatTitle/chatGist) o sobre
 * un texto ya cerrado (analyst) — la latencia tampoco pesa.
 */
const DEFAULTS: Record<Role, Policy> = {
  analyst: { model: "haiku" },
  chatTitle: { model: "haiku" },
  chatGist: { model: "haiku" },
};

const ALIASES = new Set<ModelAlias>(["sonnet", "haiku"]);
const EFFORTS = new Set<Effort>(["low", "medium", "high"]);

/**
 * Override por rol: `HERMES_MODEL_ANALYST=sonnet:low`. El modelo global
 * `HERMES_MODEL` sigue funcionando como piso para todos los roles, y el
 * override por rol le gana.
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
 * `effort` a haiku es un 400 (no lo soporta).
 */
export function optionsFor(role: Role): { model: string; effort?: Effort } {
  const p = policyFor(role);
  const out: { model: string; effort?: Effort } = { model: p.model };
  if (p.effort && p.model !== "haiku") out.effort = p.effort;
  return out;
}

/** Para el log de arranque: la tabla efectiva, sin tener que leer el .env. */
export function modelSummary(): string {
  return (Object.keys(DEFAULTS) as Role[])
    .map((r) => {
      const p = policyFor(r);
      return `${r}=${p.model}${p.effort && p.model !== "haiku" ? `/${p.effort}` : ""}`;
    })
    .join(" ");
}

/**
 * Subagentes: delegar lo mecánico (leer, buscar, resumir) a un modelo barato.
 * Es la palanca más limpia de las tres — no rompe el caché del hilo principal,
 * porque el subagente corre en su PROPIO contexto y solo devuelve su conclusión.
 * `HERMES_SUBAGENTS=off` lo apaga.
 */
export function subagentsEnabled(): boolean {
  return (process.env.HERMES_SUBAGENTS || "").toLowerCase() !== "off";
}
