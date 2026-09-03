import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env.js";
import { readProjects } from "../vault/projects.js";
import { listPreferences, recentMemories } from "../memory.js";
import { searchKnowledge } from "../knowledge.js";
import { OWNER, soulPromptBlock } from "../owner.js";

/**
 * Ensambla el system prompt de Hermes explícitamente (no dependemos del
 * autoload por cwd): identidad + perfil del vault + proyectos activos +
 * preferencias.
 *
 * INVARIANTE CRÍTICA DE COSTO — este prompt NO puede depender del mensaje.
 * El caché de prompt de Anthropic hace match por PREFIJO EXACTO y el system
 * prompt ocupa la posición 0: si cambia un solo byte entre turnos, no se
 * invalida "un pedacito" sino el prefijo COMPLETO, y el turno vuelve a cobrar
 * todo el historial a precio de entrada nueva. Antes esta función recibía el
 * mensaje del turno y metía `searchKnowledge(mensaje)` + `recentMemories()` en
 * el prompt: dos fuentes que cambian en CADA turno (la búsqueda semántica por
 * definición, y las memorias porque el propio prompt ordena guardarlas). O sea
 * que el sistema garantizaba fallo de caché en todos los turnos menos el
 * primero, y encima las auto-continuaciones (CONTINUE_PROMPT en chat-turns.ts)
 * generaban un tercer prompt distinto. Con `maxTurns: 40` × 3 continuaciones
 * eso son hasta 120 llamadas seguidas re-cobrando un historial que crece: el
 * costo sale cuadrático en vez de lineal. Era la causa del salto de 0 a 46% de
 * la ventana de 5 h en dos mensajes.
 *
 * Lo que sí depende del mensaje (memorias + conocimiento relevante) se arma
 * aparte con `buildTurnContext()` y viaja en el MENSAJE DEL USUARIO, que es
 * donde un contenido variable no rompe nada: va al final del prefijo, después
 * de todo lo cacheado.
 */
export async function buildSystemPrompt(
  focusSlug?: string,
  /** Salta la precarga de proyectos/preferencias. Lo usa el canal del reloj. */
  magro = false,
): Promise<string> {
  const parts: string[] = [];

  // Las cinco fuentes lentas se piden A LA VEZ. Encadenadas costaban la suma
  // de sus latencias, y desde este servidor cada ida a Supabase son ~1,3 s
  // (la búsqueda semántica, hasta 6): eso era el grueso de los ~9 s que
  // tardaba un turno en arrancar, no el modelo. En paralelo cuesta la más
  // lenta, no la suma.
  //
  // `magro` las salta TODAS: es lo que usa el canal del reloj. No pierde
  // capacidades — las tools siguen registradas y el agente puede pedir lo que
  // necesite con search_knowledge; lo que se quita es la precarga
  // especulativa, que para "¿cuánto espacio libre hay?" no aporta nada y se
  // paga entera antes de la primera palabra.
  const [perfilTxt, projects, prefs] = await Promise.all([
    readFile(join(env.VAULT_PATH, "10 Notas", "Perfil.md"), "utf8").catch(() => ""),
    magro ? Promise.resolve([]) : readProjects(),
    magro ? Promise.resolve({}) : listPreferences(),
  ]);

  parts.push(`# Hermes — AI OS personal de ${OWNER}

Eres **Hermes**, el sistema operativo de IA personal de ${OWNER}. Corres LOCALMENTE en su máquina (${env.MACHINE_NAME}) con acceso real a bash, archivos y su vault de Obsidian en: ${env.VAULT_PATH}

Reglas:
- Responde SIEMPRE en español, conciso y accionable.
- Cuando toques código o conceptos técnicos, sé didáctico: explica el porqué.
- El vault es la fuente de verdad de proyectos y conocimiento. Léelo cuando necesites contexto real; NUNCA inventes el estado de un proyecto.
- Usa las tools mcp__hermes__* para memoria y proyectos:
  - search_knowledge: TU PRIMERA opción para contexto histórico. Busca semánticamente en TODO lo que sabes: memorias, reuniones, ejecuciones de tareas, conversaciones pasadas (texto y voz) y notas del vault. Úsala SIEMPRE antes de preguntar algo que podrías saber.
  - save_memory: guarda hechos/aprendizajes que valga la pena recordar entre sesiones.
  - save_preference: guarda preferencias de ${OWNER} cuando exprese una ("prefiero X").
  - search_memory / get_recent_activity: búsquedas acotadas a una sola fuente.
  - get_project_status / update_project_note: leer y persistir estado de proyectos.
  - capture_idea: ideas sueltas van al Inbox del vault.
- Guarda memorias proactivamente al final de tareas significativas (qué se hizo, qué se aprendió). Escribe cada memoria autocontenida (con nombres y contexto): así la búsqueda semántica la encuentra después.
- No hagas cambios destructivos. No uses sudo. No borres fuera del vault sin instrucción explícita.
- NUNCA termines tu respuesta diciendo que "avisas cuando esté listo", "te aviso en un momento" o algo similar y te quedes ahí sin hacer nada más: no existe un "después" en el que vuelvas a escribir solo — este turno es tu única oportunidad de trabajar. Si la tarea implica varios pasos (leer, buscar, ejecutar, escribir), HAZLOS ahora mismo, uno tras otro, en este mismo turno, y usa las tools de verdad (no solo lo digas). Si de verdad no te alcanza el turno para terminar, el sistema te deja continuar solo automáticamente — pero eso pasa por seguir llamando tools, nunca por prometer que ibas a hacerlo.`);


  parts.push(
    "Tools adicionales disponibles:\n  - query_code_graph: preguntas sobre la estructura del código de hermes-os (qué depende de qué, dónde vive un módulo, cómo se conectan dos partes). Prefiérela sobre leer archivos a ciegas.",
  );

  // Persona y preferencias del dueño (SOUL.md, fuera del repo)
  const soul = soulPromptBlock();
  if (soul) parts.push(soul);

  // Perfil del usuario (si existe)
  if (perfilTxt) parts.push(`# Perfil de ${OWNER}\n${perfilTxt.slice(0, 4000)}`);

  // Proyectos activos (resumen corto)

  // Foco de conversación: si el usuario eligió un proyecto en el dashboard,
  // lo ponemos al frente del prompt con su estado completo.
  if (focusSlug && focusSlug.toLowerCase() !== "vida") {
    const fp = projects.find((p) => p.slug.toLowerCase() === focusSlug.toLowerCase());
    if (fp) {
      parts.splice(
        1,
        0,
        `# 🎯 FOCO DE CONVERSACIÓN — ${fp.name}
El usuario eligió hablar específicamente del proyecto **${fp.name}** (\`${fp.slug}\`). Centra tus respuestas en este proyecto salvo que pida explícitamente otra cosa.
Estado actual:
${fp.estado_actual.slice(0, 1000) || "(sin sección de estado)"}
Pendientes: ${fp.tareas_pendientes.slice(0, 6).join("; ") || "—"}
Si necesitas más detalle, usa get_project_status('${fp.slug}') o lee su nota en el vault.`,
      );
    }
  }

  const activos = projects.filter((p) => p.estado === "activo");
  if (activos.length) {
    parts.push(
      `# Proyectos activos\n` +
        activos
          .map(
            (p) =>
              `## ${p.name} (${p.slug})\n${p.estado_actual.slice(0, 500)}\nPendientes: ${p.tareas_pendientes.slice(0, 4).join("; ") || "—"}`,
          )
          .join("\n\n"),
    );
  }

  // Preferencias
  const prefKeys = Object.entries(prefs);
  if (prefKeys.length) {
    parts.push(
      `# Preferencias de ${OWNER}\n` +
        prefKeys.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n"),
    );
  }

  return parts.join("\n\n---\n\n");
}

/**
 * El system prompt memoizado por (foco × magro). Es la SEGUNDA mitad de la
 * invariante de caché: que la función ya no dependa del mensaje evita el caso
 * evidente, pero `readProjects()` y `listPreferences()` siguen siendo estado
 * mutable — `update_project_note` o `save_preference` a mitad de un hilo
 * cambiarían el prompt del turno siguiente y tirarían el prefijo igual.
 * Memoizar congela los bytes mientras dura la ventana.
 *
 * El TTL es de una hora para acompañar al TTL largo del caché de prompt: no
 * tiene sentido refrescar el prompt más seguido que el caché al que sirve. Lo
 * que se pierde es frescura de proyectos/preferencias dentro de la hora, y no
 * se pierde de verdad: el agente tiene `get_project_status` y
 * `search_knowledge` para leer el estado real cuando importe, que además es la
 * fuente de verdad — el bloque del prompt siempre fue un resumen recortado a
 * 500 caracteres por proyecto.
 */
const PROMPT_TTL_MS = 60 * 60 * 1000;
const promptCache = new Map<string, { at: number; prompt: string }>();

export async function systemPromptFor(focusSlug?: string, magro = false): Promise<string> {
  const key = `${focusSlug ?? ""}|${magro ? "magro" : "full"}`;
  const hit = promptCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PROMPT_TTL_MS) return hit.prompt;
  const prompt = await buildSystemPrompt(focusSlug, magro);
  promptCache.set(key, { at: now, prompt });
  return prompt;
}

/** Tira el memo (tests, y cambios de perfil/vault que se quieran ver ya). */
export function resetSystemPromptCache(): void {
  promptCache.clear();
}

const SOURCE_LABELS: Record<string, string> = {
  memory: "memoria",
  meeting: "reunión",
  execution: "ejecución",
  conversation: "chat",
  vault: "vault",
};

/**
 * Contexto VOLÁTIL del turno: memorias recientes + conocimiento relevante al
 * mensaje. El retrieval es UNIFICADO (match_knowledge): memorias, reuniones,
 * ejecuciones, conversaciones pasadas (texto/voz) y notas del vault.
 *
 * Vive fuera del system prompt A PROPÓSITO (ver el comentario largo de
 * `buildSystemPrompt`): las dos fuentes cambian en cada turno, así que en la
 * posición 0 del prefijo tiraban el caché entero. Aquí, pegado al mensaje del
 * usuario, el contenido variable queda DESPUÉS de todo lo cacheable y solo
 * cuesta lo que pesa.
 *
 * Devuelve "" si no hay nada que aportar — el llamador no debe agregar
 * encabezados vacíos al mensaje.
 */
export async function buildTurnContext(
  message: string,
  /** Cuánto contexto PRECARGAR. Lo fija el perfil de consumo (budget.ts):
   * en modo bajo se precarga poco y el agente amplía con search_knowledge
   * solo si lo necesita — se paga contexto pedido, no especulativo. */
  retrieval: { recent: number; relevant: number; chars: number } = {
    recent: 5,
    relevant: 8,
    chars: 300,
  },
  /** Salta toda la precarga. Lo usa el canal del reloj. */
  magro = false,
): Promise<string> {
  if (magro || !message.trim()) return "";

  const [recent, relevant] = await Promise.all([
    recentMemories(retrieval.recent),
    searchKnowledge(message, { limit: retrieval.relevant }),
  ]);

  const seenMemories = new Set<string>(recent.map((m) => m.id));
  const lines = recent.map(
    (m) =>
      `- [memoria·${m.type}${m.project_slug ? `·${m.project_slug}` : ""}] ${(m.summary || m.content).slice(0, retrieval.chars)}`,
  );
  for (const h of relevant) {
    if (h.source === "memory" && seenMemories.has(h.ref)) continue;
    const label = SOURCE_LABELS[h.source] ?? h.source;
    const scope = h.project_slug ? `·${h.project_slug}` : "";
    const body = h.content.replace(/\s+/g, " ").trim().slice(0, retrieval.chars);
    lines.push(`- [${label}${scope} ${h.created_at.slice(0, 10)}] ${body}`);
  }
  if (!lines.length) return "";

  return (
    `<contexto-hermes>\nLo que ya sabes que puede venir al caso (memorias recientes + búsqueda semántica sobre el mensaje). Si necesitas más, amplía con search_knowledge.\n` +
    lines.join("\n") +
    `\n</contexto-hermes>`
  );
}
