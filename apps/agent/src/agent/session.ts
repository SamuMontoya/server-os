import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { ChatToolStep, HermesTask } from "@hermes/shared";
import { env } from "../env.js";
import { emit } from "../events.js";
import { setPresence } from "../presence.js";
import { supabase } from "../supabase.js";
import { buildTurnContext, systemPromptFor } from "./system-prompt.js";
import { checkTool } from "./guardrails.js";
import { hermesMcpServer, HERMES_TOOL_NAMES } from "./tools.js";
import {
  TIERS,
  capEffort,
  capTier,
  escalateSession,
  nextTier,
  routeTurn,
  routerEnabled,
  IMAGE_FLOOR_TIER,
  type Tier,
} from "./router.js";
import { currentProfile } from "./budget.js";
import { subagentsEnabled } from "./models.js";
import { attachmentPreamble } from "../chat-attachments.js";

/**
 * Corre UN turno agéntico con el Claude Agent SDK.
 *
 * Diseño de permisos:
 * - Las tools seguras (lectura + MCP hermes + web) van en allowedTools.
 * - Bash/Write/Edit NO van en allowedTools: pasan por canUseTool, donde
 *   el guardrail (guardrails.ts) decide. Así ninguna tarea disparada por
 *   voz puede ejecutar algo destructivo sin pasar por el deny-list.
 */
export interface RunTurnOptions {
  prompt: string;
  /**
   * Rutas ABSOLUTAS de imágenes adjuntas al mensaje (ya validadas y existentes
   * en disco: las resuelve chat-attachments.ts). No viajan en base64 — al
   * modelo se le nombra la ruta y las abre con `Read`, que devuelve la imagen
   * como contenido visual. Ver el comentario largo en chat-attachments.ts.
   */
  attachments?: string[];
  resumeSessionId?: string;
  /**
   * Clave del HILO (la pestaña del chat), estable desde el primer mensaje.
   *
   * Es la que fija el nivel del router, y no `resumeSessionId`. El id de sesión
   * del SDK no existe todavía en el primer turno —lo devuelve el propio SDK en
   * el init—, así que usarlo como clave dejaba el primer mensaje sin fijar y el
   * nivel de TODO el hilo lo acababa decidiendo el SEGUNDO: un "Arregla el bug
   * del login" seguido de un "gracias" clavaba la conversación entera en haiku.
   * Reproducido en scripts/probe-pin.ts.
   */
  sessionKey?: string;
  /** Techo de nivel para ESTE turno. Lo usa el canal del reloj. */
  maxTier?: Tier;
  /** Salta la precarga de contexto del prompt de sistema (canal del reloj). */
  magro?: boolean;
  /**
   * `false` salta SOLO la recuperación semántica del turno (memorias +
   * conocimiento relevante al mensaje), no la identidad ni los proyectos.
   * Lo usan las auto-continuaciones: su mensaje es un "sigue" sintético y
   * buscar conocimiento con él es pagar por ruido. Default: true.
   */
  precargarContexto?: boolean;
  /** Interno: marca el reintento del escalado para no reintentar en bucle. */
  _escalated?: boolean;
  taskId?: string;
  /** Slug del proyecto en foco: centra el system prompt en él. */
  project?: string;
  /**
   * Directorio de trabajo de la sesión SDK. Con proyecto en foco es su
   * ruta_local: así el transcript cae en ~/.claude/projects/<repo> y
   * `claude` abierto en ese repo (Cursor) ve la MISMA conversación.
   */
  cwd?: string;
  onDelta?: (text: string) => void;
  /** Avisa el session id del SDK apenas llega el init (para tabs/resume). */
  onSession?: (sdkSessionId: string) => void;
  /** Avisa cada tool_use del turno (la consola los pinta como pasos). */
  onTool?: (step: ChatToolStep) => void;
  /**
   * Avisa QUÉ modelo va a correr este turno, en cuanto el router lo decide.
   * Se dispara otra vez en el escalado (la recursión vuelve a pasar por aquí),
   * así que el cliente ve el salto de esfuerzo tal como pasa de verdad.
   */
  onModel?: (model: string, effort?: string) => void;
  /**
   * Cancelación EXPLÍCITA del turno (⏹ Detener). Ojo: no atar esto al signal
   * de un request — que el cliente se vaya (pantalla bloqueada, cambio de app)
   * no es una orden de cancelar. Ver agent/chat-turns.ts.
   */
  abortController?: AbortController;
}

/**
 * Campo del input que mejor describe QUÉ tocó la tool, en orden de preferencia
 * (Read→file_path, Grep→pattern, WebFetch→url…). Solo extrae el dato; la UI
 * decide el verbo y cómo lo acorta.
 */
const TARGET_KEYS = [
  "file_path",
  "pattern",
  "url",
  "command",
  "query",
  "slug",
  "title",
  "name",
  "content",
];

function toolTarget(input: Record<string, unknown>): string {
  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}

export interface RunTurnResult {
  sdkSessionId?: string;
  finalText: string;
  toolCalls: number;
  isError: boolean;
  /**
   * Subtipo del `result` del SDK cuando `isError` es true (p. ej.
   * "error_max_turns", "error_during_execution", "api_error"). Antes se
   * perdía —todo colapsaba a un booleano— y quien llamaba no podía distinguir
   * "se acabó el presupuesto de turnos con el trabajo a medias" de "reventó
   * de verdad": las dos terminaban igual, con un ⚠ y Samu teniendo que
   * escribir "continúa" a mano. Ver el consumidor en chat-turns.ts (drive()).
   */
  errorSubtype?: string;
  /** Consumo real del turno, tal como lo reportó el SDK. Ver TurnUsage. */
  usage?: TurnUsage;
}

/**
 * Consumo de UN turno. `cacheado` (0-1) es el indicador que hay que vigilar:
 * es la fracción del prefijo que se reusó del caché. Un hilo sano se estabiliza
 * arriba del 90% a partir del segundo turno; si se hunde, alguien volvió a
 * meter contenido variable en el system prompt.
 */
export interface TurnUsage {
  entrada: number;
  salida: number;
  cacheEscrito: number;
  cacheLeido: number;
  /** 0-1: cacheLeido / (cacheLeido + cacheEscrito + entrada). */
  cacheado: number;
  costoUsd?: number;
}

export async function runAgentTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  // El perfil decide cuánto contexto se PRECARGA (ver budget.ts).
  const _profile = await currentProfile();
  // El system prompt es ESTABLE por sesión (memoizado, sin el mensaje dentro):
  // es lo que hace que el caché de prompt pegue turno a turno. El contexto que
  // sí depende del mensaje se arma aparte y viaja pegado al mensaje. Ver el
  // comentario largo en system-prompt.ts — de aquí venía el consumo.
  //
  // Las dos se piden a la vez: la búsqueda semántica contra Supabase son
  // varios segundos y encadenarlas era tiempo hasta la primera palabra.
  const [systemPrompt, turnContext] = await Promise.all([
    systemPromptFor(opts.project, opts.magro),
    // `precargarContexto: false` = auto-continuación (ver chat-turns.ts): el
    // mensaje es un "sigue" sintético, así que buscar conocimiento semántico
    // con él devuelve ruido y se paga igual. El contexto real ya está en el
    // historial del turno que se está continuando.
    opts.precargarContexto === false
      ? Promise.resolve("")
      : buildTurnContext(opts.prompt, _profile.retrieval, opts.magro),
  ]);

  // Enrutamiento del turno. La clasificación es local (cero tokens) y el nivel
  // queda FIJO por sesión: el caché de prompt es por modelo, así que cambiarlo
  // a mitad de un hilo tiraría el prefijo cacheado.
  //
  // Con imágenes adjuntas se le pone un PISO al nivel (ver IMAGE_FLOOR_TIER):
  // la señal no está en el texto, así que classify() no la puede ver — "mira
  // esto" clasifica como charla y caería en haiku, que en detalle visual fino
  // no da. El techo del perfil se sigue aplicando después.
  const attachments = opts.attachments ?? [];
  const route = routerEnabled()
    ? routeTurn(
        opts.prompt,
        // La clave del hilo primero: existe desde el turno 1, el id del SDK no.
        opts.sessionKey ?? opts.resumeSessionId,
        attachments.length > 0 ? IMAGE_FLOOR_TIER : undefined,
      )
    : { tier: "alto" as Tier, reason: "router desactivado", pinned: false };

  // Modo de consumo: al pasar el umbral de la ventana de 5 h (o de noche) el
  // perfil BAJA el techo del turno. Solo restringe — nunca encarece un turno
  // que el router ya había clasificado como barato.
  const profile = _profile;
  // Dos techos, y gana el más bajo: el del perfil (modo de consumo) y el que
  // pide quien llama. El del reloj es este segundo: una pantalla de 40 mm con
  // respuestas de una frase no gana nada con más esfuerzo, y lo que sí pierde
  // es lo único que ahí importa, que es el tiempo hasta la primera palabra.
  const techoLlamante = opts.maxTier ? capTier(route.tier, opts.maxTier) : route.tier;
  const tier = capTier(techoLlamante, profile.maxTier);
  const tierOpts = TIERS[tier];
  const effort = capEffort(tierOpts.effort, profile.maxEffort);
  const modelOpts = {
    model: tierOpts.model,
    ...(effort && tierOpts.model !== "haiku" ? { effort } : {}),
  };
  // Igual que con el nivel y el esfuerzo: dos techos y gana el más bajo. El del
  // nivel acota por para-qué-sirve-este-turno (router.ts) y el del perfil por
  // cuánta ventana queda (budget.ts).
  const maxTurns = Math.min(tierOpts.maxTurns, profile.maxTurns);
  // El modelo se anuncia SIEMPRE (aunque el nivel venga fijado por la sesión):
  // el cliente necesita saber con qué está respondiendo, no solo cuándo cambia.
  opts.onModel?.(tierOpts.model, effort);
  if (!route.pinned) {
    emit({
      kind: "text",
      taskId: opts.taskId,
      detail: `[router] ${tier} (${tierOpts.model}${effort ? `/${effort}` : ""}) — ${route.reason}${profile.mode !== "normal" ? ` · ${profile.mode.toUpperCase()}: ${profile.reason}` : ""}`,
    });
  }
  // Aviso EN EL CHAT (no solo en el feed de actividad, que el usuario no
  // necesariamente está mirando): si la ventana está en modo crítico y el
  // pedido pedía más de lo que ese modo permite, se lo decimos ANTES de que el
  // modelo intente responder con una fracción de la capacidad que hacía falta.
  // Fallar así es más barato que un intento a medias que hay que repetir
  // cuando vuelva la ventana.
  if (profile.mode === "critico" && techoLlamante !== tier) {
    opts.onDelta?.(
      `⚠️ La ventana de 5h está casi agotada — respondo con lo básico (haiku) hasta que se libere. Esto pedía más capacidad; si puede esperar, vuelve a intentarlo cuando se reinicie.\n\n`,
    );
  }
  let sdkSessionId: string | undefined;
  let finalText = "";
  let toolCalls = 0;
  let isError = false;
  let errorSubtype: string | undefined;
  let usage: TurnUsage | undefined;
  let deltasSeen = false;
  /**
   * Detectado en vivo (2026-09-15, ver diagnóstico en la conversación de
   * ese día): una sesión RESUMIDA (`opts.resumeSessionId`) puede quedar
   * permanentemente sin acceso a ninguna mcp__hermes__* tool si el proceso
   * @hermes/agent murió a mitad de esa sesión (SIGKILL de un restart,
   * OOM del cgroup) y luego se resume su transcript. A diferencia de la
   * carrera de arranque (que se autorresuelve en el siguiente intento), esto
   * NO se autorresuelve reintentando la MISMA sesión — el CLI nunca vuelve a
   * negociar las capacidades MCP para un resume. Se comprobó en producción:
   * 3 llamadas seguidas a distintas tools mcp__hermes__* fallaron todas con
   * "No such tool available" en la MISMA sesión resumida, incluso con 20s de
   * espera real entre medias.
   */
  let mcpStaleResume = false;

  setPresence("working", opts.prompt.slice(0, 120));

  // El preámbulo de adjuntos va SOLO al SDK. El `opts.prompt` pelado es el que
  // alimenta buildSystemPrompt (retrieval) y el que se persiste en el
  // historial: las rutas del .data no son contexto útil para la búsqueda
  // semántica ni para releer la conversación dentro de un mes.
  //
  // El contexto recuperado va DELANTE del mensaje y no en el system prompt:
  // ahí cambia en cada turno y rompería el prefijo cacheado (system-prompt.ts).
  const sdkPrompt = [
    turnContext,
    attachments.length ? attachmentPreamble(attachments) : "",
    opts.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const q = query({
      prompt: sdkPrompt,
      options: {
        cwd: opts.cwd || env.VAULT_PATH || process.cwd(),
        systemPrompt,
        ...modelOpts,
        maxTurns,
        includePartialMessages: true,
        settingSources: [],
        resume: opts.resumeSessionId,
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
        mcpServers: { hermes: hermesMcpServer },
        // Subagentes: delegar lo MECÁNICO a haiku. Leer archivos y buscar no
        // requiere el modelo caro, y cada delegación saca ese trabajo del
        // contexto del hilo principal — que es donde el costo se acumula turno
        // a turno. El subagente corre en su propio contexto y devuelve solo su
        // conclusión.
        agents: subagentsEnabled() || profile.forceSubagents
          ? {
              scout: {
                description:
                  "Explora y resume: leer archivos, buscar en el código o el vault, y recuperar contexto histórico. Úsalo SIEMPRE que necesites leer varias cosas antes de decidir — devuelve solo lo relevante.",
                prompt:
                  "Eres un explorador. Buscas y lees lo que te pidan y devuelves un resumen CORTO y factual: rutas, líneas y hechos. No opines, no propongas soluciones, no inventes. Si no encuentras algo, dilo.",
                model: "haiku",
                tools: ["Read", "Glob", "Grep", "mcp__hermes__search_knowledge", "mcp__hermes__search_memory", "mcp__hermes__search_vault", "mcp__hermes__get_project_status"],
              },
            }
          : undefined,
        // El catálogo BASE de tools built-in. Esta opción es la que RECORTA;
        // `allowedTools` (abajo) solo auto-aprueba lo que ya está cargado —
        // son dos cosas distintas y el SDK lo dice explícitamente en su tipo:
        // "To restrict which tools are available, use the `tools` option
        // instead". Sin ella se carga el preset `claude_code` COMPLETO.
        //
        // MEDIDO con el SDK (haiku, un prompt de una palabra, comparando
        // `cache_creation_input_tokens`):
        //   preset completo …… 28.855 tokens de prefijo POR TURNO
        //   esta lista ……….… 10.369
        //   tools: [] ………….…      241
        // O sea que el preset entero costaba ~18.500 tokens por turno en
        // esquemas de herramientas que este chat no usa nunca (Artifact,
        // NotebookEdit, ToolSearch, Skill, EnterPlanMode, Cron*, Monitor,
        // DesignSync, worktrees…). Multiplicado por los turnos de un mensaje
        // era la partida más grande del consumo, más que el historial.
        //
        // La lista se DERIVA de lo que este agente declara necesitar: los de
        // `allowedTools` de abajo, más Bash/Write/Edit, que a propósito NO van
        // ahí porque pasan por `canUseTool` → guardrails. Ojo: quitar uno de
        // esos tres de aquí no lo "asegura", lo hace invisible — el guardrail
        // dejaría de tener nada que vigilar y el agente no podría trabajar.
        tools: [
          "Read",
          "Glob",
          "Grep",
          "Bash",
          // BashOutput/KillShell: la contraparte de `Bash` con
          // `run_in_background: true` — sin ellas el modelo puede LANZAR un
          // comando en background pero nunca vuelve a saber de él (ni
          // revisar su salida, ni matarlo), así que "corriendo en
          // background, aviso cuando esté listo" era una promesa que no
          // podía cumplir: no tenía cómo. Faltaban del recorte de costos
          // original (ver el comentario de arriba) sin querer.
          "BashOutput",
          "KillShell",
          "Write",
          "Edit",
          "WebSearch",
          "WebFetch",
          "TodoWrite",
          ...(subagentsEnabled() || profile.forceSubagents ? ["Task"] : []),
        ],
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          // Task es cómo el agente principal invoca a los subagentes.
          ...(subagentsEnabled() || profile.forceSubagents ? ["Task"] : []),
          "WebSearch",
          "WebFetch",
          "TodoWrite",
          // Revisar/matar un shell de background PROPIO (no arbitrario del
          // sistema) es tan seguro como Read/Glob/Grep — no hay nada que
          // vigilar del lado del guardrail.
          "BashOutput",
          "KillShell",
          ...HERMES_TOOL_NAMES,
        ],
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          const verdict = checkTool(toolName, input as Record<string, unknown>);
          if (!verdict.allowed) {
            emit({
              kind: "error",
              taskId: opts.taskId,
              toolName,
              detail: `GUARDRAIL: ${verdict.reason}`,
            });
            return { behavior: "deny", message: verdict.reason ?? "Bloqueado por guardrail" };
          }
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    for await (const message of q) {
      const m = message as Record<string, any>;

      if (m.type === "system" && m.session_id) {
        sdkSessionId = m.session_id as string;
        if (m.subtype === "init") {
          opts.onSession?.(sdkSessionId);
          emit({ kind: "session_start", sessionId: sdkSessionId, taskId: opts.taskId });
        }
        continue;
      }

      // Streaming de texto (partial message events del SDK)
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          deltasSeen = true;
          opts.onDelta?.(ev.delta.text as string);
        }
        continue;
      }

      if (m.type === "assistant") {
        const content = m.message?.content ?? m.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            finalText = block.text as string;
            if (!deltasSeen) opts.onDelta?.(block.text as string);
            emit({ kind: "text", taskId: opts.taskId, detail: (block.text as string).slice(0, 200) });
          }
          if (block.type === "tool_use") {
            toolCalls += 1;
            setPresence("thinking", `${block.name}`);
            const input = (block.input ?? {}) as Record<string, unknown>;
            emit({
              kind: "tool_call",
              taskId: opts.taskId,
              toolName: block.name as string,
              detail: JSON.stringify(input).slice(0, 300),
            });
            opts.onTool?.({ name: block.name as string, target: toolTarget(input) });
          }
        }
        continue;
      }

      if (m.type === "user") {
        const content = m.message?.content ?? m.content ?? [];
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type === "tool_result") {
            const raw =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? "");
            if (opts.resumeSessionId && /No such tool available: mcp__hermes__/.test(raw)) {
              mcpStaleResume = true;
            }
            emit({
              kind: "tool_result",
              taskId: opts.taskId,
              detail: raw.slice(0, 200),
            });
          }
        }
        continue;
      }

      if (m.type === "result") {
        if (m.subtype === "success" && typeof m.result === "string") {
          // `is_error` con subtype "success" es el caso raro pero real de un
          // 429/529 que el SDK entrega COMO SI fuera texto de respuesta: sin
          // esto se pintaba el error de la API como si el agente lo hubiera
          // dicho, y encima contaba como turno "done".
          if (m.is_error) {
            isError = true;
            errorSubtype = "api_error";
            finalText = m.result || finalText;
          } else {
            finalText = m.result || finalText;
          }
        } else if (m.subtype && m.subtype !== "success") {
          // p. ej. "error_max_turns", "error_during_execution": se guarda el
          // subtipo TAL CUAL — es lo que permite a chat-turns.ts distinguir
          // "se acabó el presupuesto de turnos, hay que continuar solo" de un
          // fallo real. `finalText` NO se toca aquí: ya trae el último texto
          // parcial del asistente (bloque "assistant" de arriba), y usarlo
          // como "mensaje de error" era justo lo que hacía que el ⚠ pareciera
          // la propia respuesta del agente repetida.
          isError = true;
          errorSubtype = m.subtype as string;
        }
        // Consumo REAL del turno. Antes se descartaba entero, y eso dejaba al
        // proyecto sin poder responder su propia pregunta: "¿cuánto gastó este
        // mensaje?" solo se podía mirar en el porcentaje agregado de la ventana
        // de 5 h, que llega tarde y no dice de dónde salió. Sin este dato, una
        // mejora de consumo no se puede confirmar ni una regresión detectar.
        //
        // El que importa es `cacheado`: es la fracción del prefijo que se
        // reusó. Si baja, algo volvió a romper el caché de prompt (ver el
        // comentario largo de system-prompt.ts) y el gasto se multiplica sin
        // que cambie nada visible.
        const u = (m as { usage?: Record<string, number> }).usage;
        if (u) {
          const leido = u.cache_read_input_tokens ?? 0;
          const escrito = u.cache_creation_input_tokens ?? 0;
          const entrada = u.input_tokens ?? 0;
          const prefijo = leido + escrito + entrada;
          usage = {
            entrada,
            salida: u.output_tokens ?? 0,
            cacheEscrito: escrito,
            cacheLeido: leido,
            cacheado: prefijo > 0 ? leido / prefijo : 0,
            costoUsd: (m as { total_cost_usd?: number }).total_cost_usd,
          };
          emit({
            kind: "text",
            taskId: opts.taskId,
            detail:
              `[consumo] ${tierOpts.model}${effort ? `/${effort}` : ""} · ` +
              `prefijo ${prefijo.toLocaleString()} (caché ${Math.round(usage.cacheado * 100)}%) · ` +
              `salida ${usage.salida.toLocaleString()}` +
              (usage.costoUsd !== undefined ? ` · $${usage.costoUsd.toFixed(4)}` : ""),
          });
        }
      }
    }

    // MCP de "hermes" muerto para ESTA sesión resumida (ver el comentario
    // largo de `mcpStaleResume` arriba): mismo remedio que el catch de abajo
    // para "No conversation found" — sesión nueva, sin resume. Se limita a
    // cuando el modelo TODAVÍA no dijo nada real (`!deltasSeen && !finalText`):
    // si ya alcanzó a responder algo coherente pese al tropiezo de la tool,
    // descartarlo y repetir el turno entero sería peor que dejarlo cerrar
    // normal — el usuario ya se lo llevó puesto en pantalla.
    if (mcpStaleResume && opts.resumeSessionId && !deltasSeen && !finalText.trim()) {
      setPresence("idle");
      emit({
        kind: "error",
        taskId: opts.taskId,
        detail: "[mcp] sesión resumida sin tools hermes — reintentando con sesión nueva",
      });
      return runAgentTurn({ ...opts, resumeSessionId: undefined });
    }
  } catch (err) {
    // Resume de una sesión SDK que ya no existe (transcript limpiado o CLI
    // actualizado): reintenta UNA vez con sesión fresca. El session_id nuevo
    // se guarda al terminar el turno, así el mapeo stale se auto-repara.
    if (opts.resumeSessionId && /No conversation found with session ID/i.test(String(err))) {
      setPresence("idle");
      return runAgentTurn({ ...opts, resumeSessionId: undefined });
    }
    isError = true;
    errorSubtype = errorSubtype ?? "exception";
    finalText = finalText || `Error ejecutando al agente: ${String(err).slice(0, 500)}`;
    emit({ kind: "error", taskId: opts.taskId, detail: String(err).slice(0, 300) });
  } finally {
    setPresence("idle");
  }

  // Escalado. El router es heurístico y a veces se queda corto; en vez de
  // devolver un turno fallido, se reintenta UNA vez en el nivel de arriba.
  // Solo ante fallo real: reintentar por gusto duplica el costo del turno.
  //
  // `error_max_turns` queda FUERA a propósito: no es que el modelo se haya
  // quedado corto de capacidad, es que se acabó el presupuesto de turnos con
  // el trabajo a medias. Escalar aquí volvería a correr TODO el turno desde
  // cero en un tier más caro —duplicando el texto ya emitido, porque
  // `runAgentTurn` no sabe que ya se streameó algo— cuando lo correcto es
  // simplemente CONTINUAR en la misma sesión; eso lo hace chat-turns.ts con
  // `errorSubtype` (ver MAX_CONTINUATIONS ahí).
  // `api_error` queda fuera por la misma razón, y es la que más caro salía: un
  // 429 / 529 / overloaded / 500 no dice NADA sobre si el modelo daba la talla
  // — dice que el otro lado está saturado o que se pasó un límite. Escalar ahí
  // era contraproducente por los dos lados: se re-corría el turno entero en un
  // modelo 2,5× más caro Y con más probabilidad de volver a chocar contra el
  // límite, que es justo lo que se acaba de chocar. Reintentar en el MISMO
  // nivel con backoff es lo correcto, y eso ya lo hace chat-turns.ts
  // (`isRetryable` + BACKOFF_MS).
  //
  // Y ojo con el efecto multiplicador que tenía: `_escalated` es interno a
  // esta función, así que se reinicia en cada intento de chat-turns.ts. Con
  // MAX_ATTEMPTS = 3, una racha de 429 daba 3 intentos × 2 corridas = 6
  // ejecuciones completas del turno, subiendo de modelo por la escalera.
  const escalable = errorSubtype !== "error_max_turns" && errorSubtype !== "api_error";
  const up = nextTier(tier);
  if (isError && escalable && up && routerEnabled() && !opts._escalated) {
    // La MISMA clave que usó routeTurn, o el escalado fijaría un hilo distinto
    // del que se acaba de enrutar (y el pin quedaría sin efecto).
    escalateSession(opts.sessionKey ?? opts.resumeSessionId ?? sdkSessionId, up);
    emit({
      kind: "error",
      taskId: opts.taskId,
      detail: `[router] turno falló en ${tier} — escalando a ${up}`,
    });
    return runAgentTurn({ ...opts, resumeSessionId: sdkSessionId ?? opts.resumeSessionId, _escalated: true });
  }

  return { sdkSessionId, finalText, toolCalls, isError, errorSubtype, usage };
}

// ── Mapeo sesión-cliente (X-Hermes-Session-Id) → sesión SDK ────────────
const sessionMap = new Map<string, string>();

export async function getSdkSession(clientId: string): Promise<string | undefined> {
  if (sessionMap.has(clientId)) return sessionMap.get(clientId);
  if (supabase) {
    const { data } = await supabase
      .from("sessions")
      .select("sdk_session_id")
      .eq("title", clientId)
      .not("sdk_session_id", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.sdk_session_id) {
      sessionMap.set(clientId, data.sdk_session_id);
      return data.sdk_session_id;
    }
  }
  return undefined;
}

export async function saveSdkSession(
  clientId: string,
  sdkSessionId: string,
  channel: "text" | "voice" | "task" = "text",
) {
  const existing = sessionMap.get(clientId);
  sessionMap.set(clientId, sdkSessionId);
  if (supabase && existing !== sdkSessionId) {
    await supabase.from("sessions").insert({
      sdk_session_id: sdkSessionId,
      channel,
      title: clientId,
      machine: env.MACHINE_NAME,
    });
  }
}

// ── Registro de tareas async (para run_task por voz) ───────────────────
const tasks = new Map<string, HermesTask>();

export function startTask(prompt: string): HermesTask {
  const task: HermesTask = {
    id: randomUUID().slice(0, 8),
    prompt,
    status: "running",
    startedAt: new Date().toISOString(),
    toolCalls: 0,
  };
  tasks.set(task.id, task);
  emit({ kind: "task_start", taskId: task.id, detail: prompt.slice(0, 200) });

  void (async () => {
    const result = await runAgentTurn({ prompt, taskId: task.id });
    task.status = result.isError ? "error" : "done";
    task.result = result.finalText;
    task.toolCalls = result.toolCalls;
    task.finishedAt = new Date().toISOString();
    if (result.isError) task.error = result.finalText;
    emit({
      kind: "task_done",
      taskId: task.id,
      detail: (result.finalText || "").slice(0, 300),
    });
  })();

  return task;
}

export function getTask(id: string): HermesTask | undefined {
  return tasks.get(id);
}

export function listTasks(): HermesTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
