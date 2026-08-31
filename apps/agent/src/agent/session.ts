import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ChatToolStep, HermesTask } from "@hermes/shared";
import { env } from "../env.js";
import { emit } from "../events.js";
import { notifyMac } from "../notify.js";
import { setPresence } from "../presence.js";
import { supabase } from "../supabase.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { checkTool } from "./guardrails.js";
import { hermesMcpServer, HERMES_TOOL_NAMES } from "./tools.js";
import { linearEnabled } from "../linear.js";
import { ensureCdpChrome, CDP_URL } from "../browser.js";
import {
  TIERS,
  capEffort,
  capTier,
  escalateSession,
  nextTier,
  routeTurn,
  routerEnabled,
  type Tier,
} from "./router.js";
import { currentProfile } from "./budget.js";
import { subagentsEnabled } from "./models.js";

/**
 * MCP oficial de Linear (remoto, hosteado por ellos). Auth headless: la misma
 * LINEAR_API_KEY como Bearer — sin flujo OAuth interactivo. Híbrido a
 * propósito: crear issues va por la tool custom create_linear_issue (formato
 * "Copy prompt" garantizado por código); el MCP aporta el resto del catálogo
 * (actualizar estados, comentar, buscar proyectos/ciclos…).
 */
function linearMcpServer() {
  return {
    type: "http" as const,
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: `Bearer ${env.LINEAR_API_KEY}` },
  };
}

/**
 * MCP de chrome-devtools (navegación web agéntica). Stdio local: el node del
 * agente + el bin del paquete por ruta ABSOLUTA (launchd no tiene npx/PATH).
 * Con --browserUrl el MCP solo se CONECTA al Chrome CDP dedicado que maneja
 * browser.ts (ensureCdpChrome) — nunca lanza Chrome él mismo, así N sesiones
 * SDK concurrentes comparten la misma instancia visible.
 */
const localRequire = createRequire(import.meta.url);
let chromeMcpBin: string | null | undefined;
function resolveChromeMcpBin(): string | null {
  if (chromeMcpBin !== undefined) return chromeMcpBin;
  try {
    const pkgPath = localRequire.resolve("chrome-devtools-mcp/package.json");
    const pkg = localRequire("chrome-devtools-mcp/package.json") as {
      bin?: Record<string, string>;
    };
    const rel = pkg.bin?.["chrome-devtools-mcp"];
    chromeMcpBin = rel ? resolve(dirname(pkgPath), rel) : null;
  } catch {
    chromeMcpBin = null;
  }
  return chromeMcpBin;
}

function chromeMcpServer(bin: string) {
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [bin, `--browserUrl=${CDP_URL}`],
  };
}

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
  resumeSessionId?: string;
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
   * así que el cliente ve el salto haiku→sonnet→opus tal como pasa de verdad.
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
}

export async function runAgentTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  // El perfil decide cuánto contexto se PRECARGA (ver budget.ts).
  const _profile = await currentProfile();
  const systemPrompt = await buildSystemPrompt(opts.prompt, opts.project, _profile.retrieval);

  // Enrutamiento del turno. La clasificación es local (cero tokens) y el nivel
  // queda FIJO por sesión: el caché de prompt es por modelo, así que cambiarlo
  // a mitad de un hilo tiraría el prefijo cacheado.
  const route = routerEnabled()
    ? routeTurn(opts.prompt, opts.resumeSessionId)
    : { tier: "deep" as Tier, reason: "router desactivado", pinned: false };

  // Modo de consumo: al pasar el umbral de la ventana de 5 h (o de noche) el
  // perfil BAJA el techo del turno. Solo restringe — nunca encarece un turno
  // que el router ya había clasificado como barato.
  const profile = _profile;
  const tier = capTier(route.tier, profile.maxTier);
  const tierOpts = TIERS[tier];
  const effort = capEffort(tierOpts.effort, profile.maxEffort);
  const modelOpts = {
    model: tierOpts.model,
    ...(effort && tierOpts.model !== "haiku" ? { effort } : {}),
  };
  // El modelo se anuncia SIEMPRE (aunque el nivel venga fijado por la sesión):
  // el cliente necesita saber con qué está respondiendo, no solo cuándo cambia.
  opts.onModel?.(tierOpts.model, effort);
  if (!route.pinned) {
    emit({
      kind: "text",
      taskId: opts.taskId,
      detail: `[router] ${tier} (${tierOpts.model}${effort ? `/${effort}` : ""}) — ${route.reason}${profile.mode === "low" ? ` · BAJO CONSUMO: ${profile.reason}` : ""}`,
    });
  }
  let sdkSessionId: string | undefined;
  let finalText = "";
  let toolCalls = 0;
  let isError = false;
  let deltasSeen = false;

  setPresence("working", opts.prompt.slice(0, 120));

  try {
    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd || env.VAULT_PATH || process.cwd(),
        systemPrompt,
        ...modelOpts,
        maxTurns: profile.maxTurns,
        includePartialMessages: true,
        settingSources: [],
        resume: opts.resumeSessionId,
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
        mcpServers: {
          hermes: hermesMcpServer,
          ...(linearEnabled() ? { linear: linearMcpServer() } : {}),
          ...(env.BROWSER_AGENT_ENABLED && resolveChromeMcpBin()
            ? { "chrome-devtools": chromeMcpServer(resolveChromeMcpBin()!) }
            : {}),
        },
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
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          // Task es cómo el agente principal invoca a los subagentes.
          ...(subagentsEnabled() || profile.forceSubagents ? ["Task"] : []),
          "WebSearch",
          "WebFetch",
          "TodoWrite",
          ...HERMES_TOOL_NAMES,
          // "mcp__linear" pelado = todas las tools del server (regla de permisos
          // por prefijo). Son mutaciones de workspace, no de la máquina.
          ...(linearEnabled() ? ["mcp__linear"] : []),
        ],
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          // Tools del navegador: NO van en allowedTools a propósito — pasar
          // por aquí garantiza el Chrome CDP dedicado ANTES de cada uso (el
          // MCP solo se conecta; si el Chrome no está, el tool fallaría).
          if (toolName.startsWith("mcp__chrome-devtools__")) {
            const chrome = await ensureCdpChrome();
            if (!chrome.ok) {
              emit({ kind: "error", taskId: opts.taskId, toolName, detail: chrome.error });
              return { behavior: "deny", message: chrome.error ?? "Chrome CDP no disponible" };
            }
            return { behavior: "allow", updatedInput: input };
          }
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
          finalText = m.result || finalText;
        } else if (m.subtype && m.subtype !== "success") {
          isError = true;
        }
      }
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
    finalText = finalText || `Error ejecutando al agente: ${String(err).slice(0, 500)}`;
    emit({ kind: "error", taskId: opts.taskId, detail: String(err).slice(0, 300) });
  } finally {
    setPresence("idle");
  }

  // Escalado. El router es heurístico y a veces se queda corto; en vez de
  // devolver un turno fallido, se reintenta UNA vez en el nivel de arriba.
  // Solo ante fallo real: reintentar por gusto duplica el costo del turno.
  const up = nextTier(tier);
  if (isError && up && routerEnabled() && !opts._escalated) {
    escalateSession(opts.resumeSessionId ?? sdkSessionId, up);
    emit({
      kind: "error",
      taskId: opts.taskId,
      detail: `[router] turno falló en ${tier} — escalando a ${up}`,
    });
    return runAgentTurn({ ...opts, resumeSessionId: sdkSessionId ?? opts.resumeSessionId, _escalated: true });
  }

  return { sdkSessionId, finalText, toolCalls, isError };
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
    notifyMac(
      "tarea",
      result.isError
        ? `❌ falló: ${prompt.slice(0, 80)}`
        : `✅ terminó: ${prompt.slice(0, 80)}`,
    );
  })();

  return task;
}

export function getTask(id: string): HermesTask | undefined {
  return tasks.get(id);
}

export function listTasks(): HermesTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
