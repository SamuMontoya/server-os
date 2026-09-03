import "../env.js";
import type { Effort, ModelAlias } from "./models.js";

/**
 * Enrutamiento dinámico del turno del chat.
 *
 * Antes esto elegía MODELO (haiku/sonnet/opus) y opus costaba mucho: un
 * "hola" no debía costar lo mismo que un refactor, pero tampoco valía la pena
 * pagar un modelo aparte para el trabajo difícil. Ahora sonnet es el modelo
 * PRINCIPAL para todo lo que no es trivial, y lo que varía es el ESFUERZO
 * (bajo/medio/alto) — la misma idea de "no todo cuesta igual", pero sin el
 * salto de precio de cambiar de modelo. Opus no se usa en ningún nivel.
 *
 * Dos decisiones de diseño que son el corazón de esto:
 *
 * 1. La clasificación es LOCAL y heurística, sin llamar a ningún modelo. Un
 *    clasificador LLM costaría un turno extra por cada turno real — se comería
 *    justo lo que viene a ahorrar. Las heurísticas se equivocan a veces; para
 *    eso está el escalado.
 *
 * 2. El nivel se decide UNA VEZ por sesión y queda fijo. El caché de prompt es
 *    por modelo Y por esfuerzo (son parámetros distintos de la misma llamada):
 *    cambiar a mitad de un hilo tira el prefijo cacheado y re-cachear un hilo
 *    largo cuesta más que lo ahorrado. Por eso se enruta al ABRIR la
 *    conversación, nunca dentro.
 */

export type Tier = "trivial" | "bajo" | "medio" | "alto";

/**
 * `maxTurns` es por NIVEL, no global, y es un techo de COSTO, no de capacidad.
 *
 * Cada "turno" del SDK es una llamada al modelo que re-manda el historial
 * completo. Con un techo único para todo, "¿ya está todo arriba?" tenía el
 * mismo presupuesto de exploración que un refactor: el modelo no gasta los 28
 * si no los necesita, pero cuando se enreda —y se enreda— los gasta, y cuesta
 * lo mismo enredarse en una pregunta trivial que en una difícil.
 *
 * Los números salen de para qué sirve cada nivel: una pregunta de estado se
 * responde con una tool y una frase (6 sobra); una aclaración corta apenas
 * necesita tools (10); el grueso son búsquedas y redacción con varias tools
 * (16); el trabajo de código o de razonamiento de verdad lee, escribe y
 * verifica (28). Si un nivel se queda corto, el turno cierra con
 * `error_max_turns` y la auto-continuación lo retoma (chat-turns.ts) — el
 * trabajo no se pierde, solo se paga un techo en vez de una barra libre.
 */
export const TIERS: Record<Tier, { model: ModelAlias; effort?: Effort; maxTurns: number }> = {
  // Saludos, confirmaciones, preguntas de una línea sobre estado.
  trivial: { model: "haiku", maxTurns: 6 },
  // Aclaraciones y pedidos cortos y de baja ambigüedad.
  bajo: { model: "sonnet", effort: "low", maxTurns: 10 },
  // El grueso: preguntas con contexto, búsquedas, redacción.
  medio: { model: "sonnet", effort: "medium", maxTurns: 16 },
  // Código y razonamiento de verdad: escribir/editar, auditorías, investigación.
  alto: { model: "sonnet", effort: "high", maxTurns: 28 },
};

// ── Señales ───────────────────────────────────────────────────────────
// Todo lo que se puede saber sin gastar un token.

/**
 * Verbos que implican MODIFICAR CÓDIGO. Van a esfuerzo alto.
 *
 * Tres exclusiones que parecen inconsistentes y no lo son:
 * - `migr`: "solo hicimos la migración, no?" es PREGUNTAR por una migración.
 *   El límite de palabra no distingue eso de "migra la tabla", y preguntar es
 *   el caso frecuente.
 * - `commit`/`pnpm`/`git`: correr comandos es orquestación, no autoría —
 *   cae en el caso general (esfuerzo medio), no en este.
 * - `program` → `programa`: `program` también matcheaba "programado" y
 *   "programación".
 *
 * Si el esfuerzo asignado no da, el escalado sube un nivel y ahí se queda. El
 * costo de equivocarse por abajo es un turno; por arriba, la ventana de 5 h.
 */
const CODE_WORK =
  /\b(refactoriz|implement|programa|arregl|corrig|soluciona|depur|debug|arquitect|optimiz|reescrib|automatiz)/i;

/**
 * Marcadores de código: fences, archivos FUENTE y rutas de fuente. Van a
 * esfuerzo alto igual que CODE_WORK.
 *
 * Dos cosas a propósito:
 * - Fuera `md` (y `json`): el markdown es el formato NATIVO del vault, así que
 *   "resume mi nota de perfil.md" no debe subir de nivel. Y como el nivel
 *   queda FIJO por sesión, UNA mención de un .md dejaba el hilo entero caro.
 * - La ruta pide TRES segmentos (`apps/agent/src`), no dos: con dos, "mira el
 *   video que subí a /descargas/reunion" contaba como "código".
 */
const CODE_MARKERS =
  /```|\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|sql|sh|zsh|css|html|yaml|yml|toml)\b|\b[\w.-]+\/[\w.-]+\/[\w.-]+|\$\(|=>/i;

/**
 * Verbos de razonamiento pesado: auditorías, investigación, análisis. No son
 * escribir código, pero SÍ son "pensar y razonar" de verdad — van a esfuerzo
 * alto igual que el código, solo que en vez de tools de escritura usan
 * búsqueda y síntesis. Antes de tener niveles de esfuerzo, esto era el
 * dilema: mandarlos a opus (caro) o aplanarlos al caso general (subestimar la
 * tarea). Con esfuerzo alto sobre sonnet no hace falta elegir.
 */
const DEEP_REASONING = /\b(analiz|audit|investig|compar|planific|resuelv)/i;

/**
 * Orquestación: correr comandos, git, deploy, instalar dependencias. NO es
 * autoría de código (por eso CODE_WORK los excluye a propósito — ver su
 * comentario), pero tampoco es charla: sigue siendo trabajo real sobre el
 * sistema, y el dueño pidió explícitamente que esto se quede en sonnet, no
 * que caiga a haiku por no ser "código". Esfuerzo bajo, no alto: ejecutar y
 * leer el resultado de un comando pide menos vueltas que escribir/editar.
 */
const ORCHESTRATION =
  /\b(commit|push|pull request|deploy(a|ar)?|despliegu|pnpm|npm|yarn|reinicia|restart|instala|systemctl|journalctl)\b|\bgit\b/i;

/**
 * Charla y continuaciones: saludos, gracias, confirmaciones, "sigue", "TLDR".
 *
 * Incluye las continuaciones porque son la mitad de lo que se escribe en un
 * hilo vivo y no traen trabajo nuevo.
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
 *
 * Filosofía (pedido explícito del dueño): HAIKU es el default para charla —
 * respuestas cortas, directas, al estilo TLDR que ya prefiere. SONNET (con su
 * escalera de esfuerzo bajo/medio/alto) es solo para código, orquestación
 * (correr comandos, deploy, git) y razonamiento pesado (auditar, investigar,
 * analizar) — el trabajo real sobre el sistema, no la conversación alrededor.
 * Antes el "caso general" (búsquedas, redacción, pedidos largos sin más
 * señal) caía en sonnet/medio por defecto; ahora cae en trivial salvo que
 * dispare una de las señales de abajo.
 */
export function classify(prompt: string): RouteDecision {
  // Se quitan los signos de apertura: "¿qué tengo hoy?" tiene que matchear los
  // patrones anclados en ^ igual que "qué tengo hoy".
  const p = prompt.trim().replace(/^[¿¡\s]+/, "");
  const words = p.split(/\s+/).length;

  // Lo barato se decide PRIMERO. Antes iba al final y por eso no se alcanzaba
  // casi nunca: cualquier verbo de la lista larga lo adelantaba por izquierda.
  if (CHITCHAT.test(p)) return { tier: "trivial", reason: "saludo o continuación" };
  // 10 y no 8: "Que sub carpetas tienes? TLDR" son 5 pero "ya está todo arriba
  // en el repo de kreanding?" son 9 y sigue siendo una pregunta de una frase.
  if (words <= 10 && STATUS_Q.test(p))
    return { tier: "trivial", reason: "pregunta de estado corta" };

  if (CODE_MARKERS.test(p)) return { tier: "alto", reason: "código o ruta de fuente" };
  if (CODE_WORK.test(p)) return { tier: "alto", reason: "verbo de modificar código" };
  if (DEEP_REASONING.test(p)) return { tier: "alto", reason: "auditoría, investigación o análisis" };
  if (ORCHESTRATION.test(p))
    return { tier: "bajo", reason: "orquestación: correr comandos, no autoría de código" };

  // Todo lo demás es charla, preguntas o redacción sin trabajo real de por
  // medio: Haiku responde corto y directo, que es justo lo que se pidió.
  return { tier: "trivial", reason: "charla o pregunta general — sonnet no hace falta" };
}

// ── Fijación por sesión ───────────────────────────────────────────────
// sessionId → nivel. Sin esto, el segundo mensaje de un hilo podría caer en
// otro nivel y tirar el caché del primero.

const pinned = new Map<string, Tier>();
// Cota simple: un dashboard abierto meses acumularía sesiones muertas.
const MAX_PINNED = 500;

/**
 * `floor` sube el nivel de ESTE turno si la clasificación (o el pin de la
 * sesión) se queda por debajo. Existe para las señales que no están en el
 * texto: imágenes adjuntas.
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

const ORDER: Tier[] = ["trivial", "bajo", "medio", "alto"];

export function nextTier(t: Tier): Tier | null {
  const i = ORDER.indexOf(t);
  return i === -1 || i === ORDER.length - 1 ? null : ORDER[i + 1];
}

/** `HERMES_ROUTER=off` deja todo en el nivel `alto` (comportamiento anterior). */
export function routerEnabled(): boolean {
  return (process.env.HERMES_ROUTER || "").toLowerCase() !== "off";
}

// ── Techo por modo de consumo ─────────────────────────────────────────

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
 * a propósito — en modo bajo consumo una imagen se analiza con el techo del
 * perfil, antes que romper el límite de la ventana de 5 h.
 */
export function raiseTier(tier: Tier, floor?: Tier): Tier {
  if (!floor) return tier;
  return ORDER.indexOf(tier) < ORDER.indexOf(floor) ? floor : tier;
}

/**
 * Nivel mínimo para un turno con imágenes: `medio` → sonnet con esfuerzo real.
 *
 * Por qué no `trivial` (haiku, el más barato): el caso de uso real es "mira
 * este bug visual" — márgenes de pocos píxeles, alineaciones, contraste. Ahí
 * haiku falla en el detalle fino y responde de forma genérica, y un análisis
 * visual equivocado sale más caro que el turno que se ahorró (hay que
 * repetirlo, y encima con la imagen otra vez).
 *
 * Y no `alto`: si el mensaje ADEMÁS pide trabajo técnico, classify() ya lo
 * manda ahí por su cuenta. Este piso solo evita el suelo.
 */
export const IMAGE_FLOOR_TIER: Tier = "medio";

export function capEffort(effort: Effort | undefined, max: Effort): Effort | undefined {
  const order: Effort[] = ["low", "medium", "high"];
  if (!effort) return effort;
  return order.indexOf(effort) > order.indexOf(max) ? max : effort;
}
