import "../env.js";
import type { Effort, ModelAlias } from "./models.js";

/**
 * Enrutamiento dinámico del turno de la consola.
 *
 * Antes la consola usaba opus/high para TODO: un "hola" costaba lo mismo que
 * "refactoriza este módulo". Aquí se clasifica el mensaje y se elige el nivel.
 *
 * Dos decisiones de diseño que son el corazón de esto:
 *
 * 1. La clasificación es LOCAL y heurística, sin llamar a ningún modelo. Un
 *    clasificador LLM costaría un turno extra por cada turno real — se comería
 *    justo lo que viene a ahorrar. Las heurísticas se equivocan a veces; para
 *    eso está el escalado.
 *
 * 2. El nivel se decide UNA VEZ por sesión y queda fijo. El caché de prompt es
 *    por modelo: cambiar de modelo a mitad de un hilo tira el prefijo cacheado
 *    y re-cachear un hilo largo cuesta más que lo ahorrado. Por eso se enruta
 *    al ABRIR la conversación, nunca dentro.
 */

export type Tier = "light" | "standard" | "deep";

export const TIERS: Record<Tier, { model: ModelAlias; effort?: Effort }> = {
  // Saludos, confirmaciones, preguntas de una línea sobre estado.
  light: { model: "haiku" },
  // El grueso: preguntas con contexto, búsquedas, redacción.
  standard: { model: "sonnet", effort: "medium" },
  // Código, diseño, análisis de varios pasos.
  deep: { model: "opus", effort: "high" },
};

// ── Señales ───────────────────────────────────────────────────────────
// Todo lo que se puede saber sin gastar un token.

/** Verbos que implican TRABAJO, no consulta. */
const DEEP_VERBS =
  /\b(refactoriz|implement|program|arregl|corrig|depur|debug|migr|dise[ñn]|arquitect|arregla|optimiz|arreglar|reescrib|analiz|audit|investig|compar|planific|resuelv|automatiz)/i;

/** Marcadores de código o rutas: casi siempre trabajo técnico. */
const CODE_MARKERS = /```|\b\w+\.(ts|tsx|js|jsx|py|sql|json|sh|md)\b|\/[\w.-]+\/[\w.-]+|\$\(|=>/;

/** Charla: saludos, gracias, confirmaciones. */
const CHITCHAT =
  /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|qu[eé] tal|gracias|listo|ok|okay|dale|perfecto|s[ií]|no|entendido|vale)\b[\s!.,]*$/i;

/** Preguntas de estado que se responden con una tool y una frase. */
const STATUS_Q =
  /^(qu[eé] (tengo|hay|falta|sigue)|c[oó]mo (va|voy|est[aá])|cu[aá]l(es)? (es|son)|cu[aá]nto|d[oó]nde est[aá]|resumen|recu[eé]rdame|mis (tareas|h[aá]bitos|notas))/i;

export interface RouteDecision {
  tier: Tier;
  reason: string;
}

/**
 * Clasifica un mensaje. El orden importa: las señales fuertes de trabajo ganan
 * sobre la forma superficial del texto (una pregunta corta puede ser dura).
 */
export function classify(prompt: string): RouteDecision {
  // Se quitan los signos de apertura: "¿qué tengo hoy?" tiene que matchear los
  // patrones anclados en ^ igual que "qué tengo hoy".
  const p = prompt.trim().replace(/^[¿¡\s]+/, "");
  const words = p.split(/\s+/).length;

  if (CODE_MARKERS.test(p)) return { tier: "deep", reason: "código o rutas en el mensaje" };
  if (DEEP_VERBS.test(p)) return { tier: "deep", reason: "verbo de trabajo técnico" };
  // Un mensaje largo casi nunca es trivial, aunque no traiga palabras clave.
  if (words > 60) return { tier: "deep", reason: `mensaje largo (${words} palabras)` };

  if (CHITCHAT.test(p)) return { tier: "light", reason: "saludo o confirmación" };
  // 8 y no 12: "resumen de la semana pasada con detalle de lo que quedó
  // pendiente" son 11 palabras y NO es una consulta de una frase.
  if (words <= 8 && STATUS_Q.test(p)) return { tier: "light", reason: "pregunta de estado corta" };

  return { tier: "standard", reason: "caso general" };
}

// ── Fijación por sesión ───────────────────────────────────────────────
// sessionId → nivel. Sin esto, el segundo mensaje de un hilo podría caer en
// otro modelo y tirar el caché del primero.

const pinned = new Map<string, Tier>();
// Cota simple: un dashboard abierto meses acumularía sesiones muertas.
const MAX_PINNED = 500;

export function routeTurn(prompt: string, sessionId?: string): RouteDecision & { pinned: boolean } {
  if (sessionId) {
    const prev = pinned.get(sessionId);
    if (prev) return { tier: prev, reason: "nivel fijado al abrir la sesión", pinned: true };
  }
  const decision = classify(prompt);
  if (sessionId) {
    if (pinned.size >= MAX_PINNED) pinned.delete(pinned.keys().next().value as string);
    pinned.set(sessionId, decision.tier);
  }
  return { ...decision, pinned: false };
}

/**
 * Sube de nivel una sesión ya fijada. Lo usa el escalado cuando el turno
 * fracasa: a partir de ahí la conversación sigue en el nivel alto (volver a
 * bajar tiraría el caché otra vez por un ahorro que ya se demostró falso).
 */
export function escalateSession(sessionId: string | undefined, to: Tier): void {
  if (sessionId) pinned.set(sessionId, to);
}

export function nextTier(t: Tier): Tier | null {
  return t === "light" ? "standard" : t === "standard" ? "deep" : null;
}

/** `HERMES_ROUTER=off` deja todo en el nivel `deep` (comportamiento anterior). */
export function routerEnabled(): boolean {
  return (process.env.HERMES_ROUTER || "").toLowerCase() !== "off";
}
