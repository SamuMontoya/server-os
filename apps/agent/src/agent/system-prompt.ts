import { isEnabled } from "@hermes/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env, IS_MAC } from "../env.js";
import { readProjects } from "../vault/projects.js";
import { listPreferences, recentMemories } from "../memory.js";
import { searchKnowledge } from "../knowledge.js";
import { getFinanceSummary, summaryToText } from "../finance/advisor.js";
import { balancesToText } from "../finance/wallets.js";
import { habitsToday } from "../habits/store.js";
import { listGoals } from "../habits/goals.js";
import { OWNER, soulPromptBlock } from "../owner.js";

/**
 * Contexto de ASESOR FINANCIERO para el chat de la página /vida (scope
 * "vida"): saldo por billetera + resumen del mes (COP y USD) + hábitos y
 * metas, SIEMPRE frescos (se arma en cada turno, server-side). El agente ya
 * tiene las tools mcp__hermes__* de finanzas para bajar al detalle.
 */
async function buildVidaContext(): Promise<string> {
  const [saldo, cop, usd, habits, goals] = await Promise.all([
    balancesToText(),
    getFinanceSummary(undefined, "COP"),
    getFinanceSummary(undefined, "USD"),
    habitsToday(),
    listGoals("active"),
  ]);
  const lines: string[] = [
    `# 🎯 MODO ASESOR FINANCIERO — página Vida
El usuario está en su página VIDA (finanzas personales + hábitos + metas) hablando contigo como SU ASESOR FINANCIERO y coach personal. Sé cercano, concreto y accionable; sin regañar. Analiza con las cifras REALES de abajo — nunca inventes números.`,
  ];
  if (saldo) lines.push(saldo);
  if (cop.tx_count) lines.push(summaryToText(cop));
  if (usd.tx_count) lines.push(summaryToText(usd));
  if (habits.length) {
    const pend = habits.filter((h) => !h.done_today).map((h) => h.name);
    lines.push(
      `Hábitos de hoy: ${habits
        .map((h) => `${h.done_today ? "✓" : "○"} ${h.name} (racha ${h.streak})`)
        .join(" · ")}${pend.length ? ` — pendientes: ${pend.join(", ")}` : ""}.`,
    );
  }
  if (goals.length) {
    lines.push(
      `Metas activas: ${goals
        .map((g) =>
          g.target_value != null
            ? `${g.title} ${g.current_value}/${g.target_value}${g.unit ? ` ${g.unit}` : ""}`
            : `${g.title} (${g.milestones.filter((m) => m.done).length}/${g.milestones.length} hitos)`,
        )
        .join(" · ")}.`,
    );
  }
  if (isEnabled("vida"))
    lines.push(
    `Herramientas de asesor (mcp__hermes__*): log_transaction registra gastos/ingresos al vuelo (con account si nombra billetera: bancolombia, nu, nequi, ontop — el saldo se ajusta solo); get_balance el saldo vivo; set_wallet_balance recalibra una billetera; get_finance_summary y list_transactions para análisis con detalle; set_budget presupuestos; log_habit / get_habits_today / manage_habit / update_goal para hábitos y metas. Si ${OWNER} menciona un gasto, regístralo sin pedir permiso y confírmalo en una frase.`,
  );
  return lines.join("\n\n");
}

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


  // Estas líneas describen tools que solo existen si su feature está encendida.
  // Dejarlas fijas costaba ~500 tokens por TURNO enseñándole al modelo a llamar
  // herramientas no registradas — gasto y alucinación a la vez.
  const toolDocs: string[] = [];
  if (isEnabled("juntas")) toolDocs.push("  - search_meetings: busca en actas de reuniones pasadas.");
  if (isEnabled("codegraph"))
    toolDocs.push(
      "  - query_code_graph: preguntas sobre la estructura del código de hermes-os (qué depende de qué, dónde vive un módulo, cómo se conectan dos partes). Prefiérela sobre leer archivos a ciegas.",
    );
  if (isEnabled("linear"))
    toolDocs.push(
      '  - create_linear_issue / list_linear_issues: manejo de tareas en Linear. Al crear un issue, PRIMERO junta contexto real (get_project_status, search_knowledge, query_code_graph) y luego redacta: título imperativo específico; description en markdown con qué/por qué, archivos o rutas relevantes y criterios de aceptación; y prompt = un prompt AUTOCONTENIDO listo para copiar-pegar en Claude Code (ruta local del repo, instrucciones concretas, criterios de aceptación y cómo verificar) — se publica al final del issue como bloque "Copy prompt". Lista antes de crear si sospechas duplicado; pasa project (slug del vault) para que quede etiquetado.',
      '  - mcp__linear__* (MCP oficial de Linear, si está conectado): para TODO lo demás de Linear — actualizar estado/prioridad/asignación, comentar, buscar issues o proyectos, ciclos. Para CREAR issues usa SIEMPRE create_linear_issue (garantiza el bloque Copy prompt); nunca crees issues con el MCP.',
    );
  if (IS_MAC && env.BROWSER_AGENT_ENABLED)
    toolDocs.push(
      `  - mcp__chrome-devtools__* (si están disponibles): NAVEGAR la web de verdad en un Chrome dedicado VISIBLE (perfil "Hermes", con sesiones persistidas). Flujo: navega a la página → toma un snapshot para ver los elementos y sus uids → interactúa (click/llenar) con esos uids → verifica con otro snapshot. ${OWNER} está VIENDO esa ventana: no cierres pestañas que no abriste. Si un sitio pide login, no intentes credenciales — reporta que ${OWNER} inicie sesión una vez en ese perfil.`,
    );
  if (toolDocs.length) parts.push(`Tools adicionales disponibles:\n${toolDocs.join("\n")}`);

  // Persona y preferencias del dueño (SOUL.md, fuera del repo)
  const soul = soulPromptBlock();
  if (soul) parts.push(soul);

  // Perfil del usuario (si existe)
  if (perfilTxt) parts.push(`# Perfil de ${OWNER}\n${perfilTxt.slice(0, 4000)}`);

  // Proyectos activos (resumen corto)

  // Scope "vida" (chat de la página /vida): modo asesor financiero con
  // datos frescos al frente del prompt. No es un proyecto del vault.
  if (focusSlug?.toLowerCase() === "vida") {
    try {
      parts.splice(1, 0, await buildVidaContext());
    } catch (err) {
      console.error("[system-prompt] contexto vida:", err);
    }
  }

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
