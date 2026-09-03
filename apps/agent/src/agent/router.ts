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

/**
 * `maxTurns` es por NIVEL, no global, y es un techo de COSTO, no de capacidad.
 *
 * Cada "turno" del SDK es una llamada al modelo que re-manda el historial
 * completo. Con un techo único de 40 para todo, "¿ya está todo arriba?" tenía
 * el mismo presupuesto de exploración que un refactor: el modelo no gasta los
 * 40 si no los necesita, pero cuando se enreda —y se enreda— los gasta, y
 * cuesta lo mismo enredarse en una pregunta trivial que en una difícil.
 *
 * Los números salen de para qué sirve cada nivel: una pregunta de estado se
 * responde con una tool y una frase (6 sobra); el grueso son búsquedas y
 * redacción con varias tools (16); el trabajo de código de verdad lee, escribe
 * y verifica (28). Si un nivel se queda corto, el turno cierra con
 * `error_max_turns` y la auto-continuación lo retoma (chat-turns.ts) — el
 * trabajo no se pierde, solo se paga un techo en vez de una barra libre.
 */
export const TIERS: Record<Tier, { model: ModelAlias; effort?: Effort; maxTurns: number }> = {
  // Saludos, confirmaciones, preguntas de una línea sobre estado.
  light: { model: "haiku", maxTurns: 6 },
  // El grueso: preguntas con contexto, búsquedas, redacción.
  standard: { model: "sonnet", effort: "medium", maxTurns: 16 },
  // Código: leer, escribir, verificar.
  deep: { model: "opus", effort: "high", maxTurns: 28 },
};

// ── Señales ───────────────────────────────────────────────────────────
// Todo lo que se puede saber sin gastar un token.

/**
 * Verbos que implican MODIFICAR CÓDIGO. Solo estos justifican opus.
 *
 * La lista se recortó a la mitad a propósito. Antes incluía
 * `analiz|audit|investig|compar|planific|resuelv|dise[ñn]` y esos no son
 * escribir código: son consulta, orquestación y coordinación entre tools —
 * trabajo de sonnet. Medido contra 37 mensajes reales del dueño, esos siete
 * verbos eran 4 de los 5 turnos que abrían en opus/high ("auditate a ti
 * mismo…", "Investiga en las carpetas…", "Analiza el repo…"): consultas, no
 * refactors.
 *
 * Tres exclusiones que parecen inconsistentes y no lo son:
 * - `migr`: "solo hicimos la migración, no?" es PREGUNTAR por una migración.
 *   El límite de palabra no distingue eso de "migra la tabla", y preguntar es
 *   el caso frecuente.
 * - `commit`/`pnpm`/`git`: correr comandos es orquestación, no autoría. Es
 *   literalmente el caso que pidió mover a sonnet.
 * - `program` → `programa`: `program` también matcheaba "programado",
 *   "programación" y el nombre de etapa del Estudio.
 *
 * Si sonnet no da, el escalado sube el hilo a opus y ahí se queda. El costo de
 * equivocarse por abajo es un turno; por arriba, la ventana de 5 h.
 */
const CODE_WORK =
  /\b(refactoriz|implement|programa|arregl|corrig|soluciona|depur|debug|arquitect|optimiz|reescrib|automatiz)/i;

/**
 * Marcadores de código: fences, archivos FUENTE y rutas de fuente.
 *
 * Dos cambios contra la versión anterior, los dos por falsos positivos que se
 * disparaban con el lenguaje normal del producto:
 * - Fuera `md` (y `json`): el markdown es el formato NATIVO del vault, así que
 *   "resume mi nota de perfil.md" caía en opus. Y como el nivel queda FIJO por
 *   sesión, UNA mención de un .md dejaba el hilo entero en opus/high.
 * - La ruta ahora pide TRES segmentos (`apps/agent/src`), no dos: con dos,
 *   "mira el video que subí a /descargas/reunion" era "código".
 */
const CODE_MARKERS =
  /```|\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|sql|sh|zsh|css|html|yaml|yml|toml)\b|\b[\w.-]+\/[\w.-]+\/[\w.-]+|\$\(|=>/i;

/**
 * Charla y continuaciones: saludos, gracias, confirmaciones, "sigue", "TLDR".
 *
 * Incluye las continuaciones porque son la mitad de lo que se escribe en un
 * hilo vivo y no traen trabajo nuevo. Antes `light` no se disparaba NUNCA
 * (0 de 37 mensajes reales): el nivel barato existía en la tabla y estaba
 * muerto en la práctica.
 */
const CHITCHAT =
  /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|qu[eé] tal|gracias|listo|ok|okay|dale|perfecto|s[ií]|no|entendido|vale|sigue|contin[uú]a|tldr)\b[\s!.,]*$/i;

/** Preguntas de estado que se responden con una tool y una frase. */
const STATUS_Q =
  /^(qu[eé] (tengo|hay|falta|sigue|ponemos|sub)|c[oó]mo (va|voy|est[aá])|cu[aá]l(es)? (es|son)|cu[aá]nto|d[oó]nde est[aá]|resumen|recu[eé]rdame|ya est[aá]|con el \d|mis (tareas|h[aá]bitos|notas))/i;

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

  // Lo barato se decide PRIMERO. Antes iba al final y por eso no se alcanzaba
  // casi nunca: cualquier verbo de la lista larga lo adelantaba por izquierda.
  if (CHITCHAT.test(p)) return { tier: "light", reason: "saludo o continuación" };
  // 10 y no 8: "Que sub carpetas tienes? TLDR" son 5 pero "ya está todo arriba
  // en el repo de kreanding?" son 9 y sigue siendo una pregunta de una frase.
  if (words <= 10 && STATUS_Q.test(p))
    return { tier: "light", reason: "pregunta de estado corta" };

  if (CODE_MARKERS.test(p)) return { tier: "deep", reason: "código o ruta de fuente" };
  if (CODE_WORK.test(p)) return { tier: "deep", reason: "verbo de modificar código" };

  // Ya NO existe la regla "mensaje largo (>60 palabras) → deep". Era una
  // proxy mala: el dueño escribe pidiendo las cosas en párrafos largos y
  // discursivos, y la longitud medía su estilo de escritura, no la dificultad
  // de la tarea. Este mismo encargo ("arregla el consumo… audita… corre 5
  // veces…") pasa las 60 palabras y es coordinación, no un refactor. Un
  // mensaje largo sin verbo de código ni ruta de fuente cae en sonnet, que es
  // donde el dueño pidió que viviera la orquestación.
  return { tier: "standard", reason: "caso general" };
}

// ── Fijación por sesión ───────────────────────────────────────────────
// sessionId → nivel. Sin esto, el segundo mensaje de un hilo podría caer en
// otro modelo y tirar el caché del primero.

const pinned = new Map<string, Tier>();
// Cota simple: un dashboard abierto meses acumularía sesiones muertas.
const MAX_PINNED = 500;

/**
 * `floor` sube el nivel de ESTE turno si la clasificación (o el pin de la
 * sesión) se queda por debajo. Existe para las señales que no están en el
 * texto: hoy, imágenes adjuntas.
 *
 * Por qué el piso gana también al pin: el pin protege el caché de prompt, pero
 * un turno con imagen ya no puede reusar el prefijo cacheado del turno anterior
 * de todas formas (el contenido cambió), así que no hay caché que proteger. Y
 * el pin se ACTUALIZA al nivel nuevo en vez de quedarse abajo: si el hilo pasó
 * a ir sobre una captura, el resto del hilo sigue siendo sobre eso.
 */
export function routeTurn(
  prompt: string,
  sessionId?: string,
  floor?: Tier,
): RouteDecision & { pinned: boolean } {
  const prev = sessionId ? pinned.get(sessionId) : undefined;
  if (prev) {
    const raised = raiseTier(prev, floor);
    if (raised !== prev && sessionId) pinned.set(sessionId, raised);
    return raised === prev
      ? { tier: prev, reason: "nivel fijado al abrir la sesión", pinned: true }
      : { tier: raised, reason: "imágenes adjuntas: se sube el nivel del hilo", pinned: false };
  }
  const decision = classify(prompt);
  const tier = raiseTier(decision.tier, floor);
  const reason = tier === decision.tier ? decision.reason : "imágenes adjuntas";
  if (sessionId) {
    if (pinned.size >= MAX_PINNED) pinned.delete(pinned.keys().next().value as string);
    pinned.set(sessionId, tier);
  }
  return { tier, reason, pinned: false };
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

// ── Techo por modo de consumo ─────────────────────────────────────────

const ORDER: Tier[] = ["light", "standard", "deep"];

/**
 * Baja el nivel si supera el techo del perfil activo. Nunca lo SUBE: el modo
 * de bajo consumo solo puede restringir, no encarecer un turno que el router
 * ya había clasificado como barato.
 */
export function capTier(tier: Tier, max: Tier): Tier {
  return ORDER.indexOf(tier) > ORDER.indexOf(max) ? max : tier;
}

/**
 * Sube el nivel al piso dado. Es el espejo de `capTier`: nunca BAJA.
 *
 * Ojo al orden en el que se aplican los dos en session.ts: primero el piso
 * (dentro de routeTurn), después el techo del perfil (capTier). El techo gana
 * a propósito — en modo bajo consumo una imagen se analiza con haiku, que
 * también ve imágenes, antes que romper el límite de la ventana de 5 h.
 */
export function raiseTier(tier: Tier, floor?: Tier): Tier {
  if (!floor) return tier;
  return ORDER.indexOf(tier) < ORDER.indexOf(floor) ? floor : tier;
}

/**
 * Nivel mínimo para un turno con imágenes: `standard` → sonnet.
 *
 * Por qué no `light` (haiku, que es el más barato de los tres y también ve
 * imágenes): el caso de uso real es "mira este bug visual" — márgenes de
 * pocos píxeles, alineaciones, contraste. Ahí haiku-4.5 falla en el detalle
 * fino y responde de forma genérica, y un análisis visual equivocado sale más
 * caro que el turno que se ahorró (hay que repetirlo, y encima con la imagen
 * otra vez). Sonnet es el punto donde la lectura de UI ya es fiable.
 *
 * Y no `deep` (opus): si el mensaje ADEMÁS pide trabajo técnico, classify()
 * ya lo manda a deep por su cuenta. Este piso solo evita el suelo.
 */
export const IMAGE_FLOOR_TIER: Tier = "standard";

const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function capEffort(effort: Effort | undefined, max: Effort): Effort | undefined {
  if (!effort) return effort;
  return EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(max) ? max : effort;
}
