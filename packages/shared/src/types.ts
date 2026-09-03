// Tipos compartidos entre el agent server (apps/agent) y el dashboard (apps/web).

export type MemoryType =
  | "user"
  | "feedback"
  | "project"
  | "reference"
  | "daily"
  | "agent";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  summary: string | null;
  project_slug: string | null;
  tags: string[];
  importance: number;
  source: string;
  machine: string | null;
  created_at: string;
}

/** Fuente de un resultado de la base de conocimiento unificada (RPC match_knowledge). */
export type KnowledgeSource =
  | "memory"
  | "meeting"
  | "execution"
  | "conversation"
  | "vault";

/** Un hit de búsqueda semántica cross-fuente: memorias, reuniones, ejecuciones,
 *  conversaciones (texto/voz) y notas del vault. */
export interface KnowledgeHit {
  source: KnowledgeSource;
  /** Ancla dentro de su fuente: uuid de memoria, meeting_id, execution_id, id de mensaje o path del vault. */
  ref: string;
  title: string;
  content: string;
  project_slug: string | null;
  created_at: string;
  similarity: number | null;
  score: number | null;
}

export interface ProjectStatus {
  slug: string;
  name: string;
  estado: string;
  rama?: string;
  ruta_local?: string;
  estado_actual: string;
  tareas_pendientes: string[];
  actualizado?: string;
}

/**
 * Un documento .md del vault resuelto desde una referencia (wikilink `[[nombre]]`
 * o ruta `docs/x.md`). Lo consume el visor tipo Notion del dashboard.
 */
export interface VaultDoc {
  found: boolean;
  /** La referencia original tal cual venía en el texto. */
  ref: string;
  /** Nombre del archivo sin extensión (basename). */
  name?: string;
  /** Título legible: frontmatter `proyecto`/`title` o el basename. */
  title?: string;
  /** Ruta relativa al vault, para el breadcrumb. */
  path?: string;
  /** Cuerpo markdown ya sin frontmatter. */
  markdown?: string;
  /** Fecha de `actualizado` del frontmatter, si existe. */
  updated?: string;
}

/** Resumen de un chat archivado de la consola (historial de chats). */
export interface ChatSummary {
  id: string;
  /** primer mensaje del usuario, recortado (título del chat). */
  title: string;
  /** fecha ISO del último mensaje. */
  ts: string;
  /** cantidad de mensajes. */
  messages: number;
}

// ── Sesiones de la consola leídas DIRECTO de ~/.claude/projects ────────
// (la misma fuente que ve `claude` abierto en Cursor dentro del repo)

/** Mensaje de texto de una sesión (user/assistant, sin tools ni thinking). */
export interface ChatSessionMessage {
  role: "user" | "assistant";
  content: string;
}

/** Resumen de una sesión de Claude para el historial/tabs de la consola. */
export interface ChatSessionSummary {
  /** uuid de la sesión (= nombre del .jsonl; sirve para resume). */
  id: string;
  title: string;
  /** última actividad (ISO, del mtime del archivo). */
  updatedAt: string;
  /** nº de mensajes de texto user+assistant. */
  messages: number;
}

/** Detalle de una sesión: sus mensajes de texto en orden. */
export interface ChatSessionDetail extends ChatSessionSummary {
  transcript: ChatSessionMessage[];
}

/** Una skill del proyecto, leída de .claude/skills/<name>/SKILL.md. */
export interface ProjectSkill {
  name: string;
  description: string;
}

/** Un server MCP declarado en el .mcp.json del proyecto. */
export interface ProjectMcpServer {
  name: string;
  /** stdio | http | sse | unknown — inferido de la config. */
  kind: string;
  /** command o url resumidos, como pista de qué es. */
  detail?: string;
  /** ¿habilitado explícitamente en settings? (undefined = sin dato). */
  enabled?: boolean;
}

/** Estado git real del repo local del proyecto (panel Versión del dashboard). */
export interface ProjectGit {
  /** rama actual (HEAD). */
  rama: string;
  /** hash corto del último commit. */
  commit: string;
  /** primera línea del mensaje del último commit (título). */
  mensaje: string;
  /** cuerpo del mensaje del commit (descripción); "" si no tiene. */
  descripcion: string;
  /** fecha del último commit (epoch ms). */
  commitAt: number;
  /** archivos con cambios sin commitear (git status --porcelain). */
  archivosCambiados: number;
}

/**
 * Contexto operativo de un proyecto: qué skills, MCP, herramientas y comandos
 * tiene su repo local (leído de ruta_local/.claude + .mcp.json). Lo consume el
 * panel de contexto del dashboard cuando se enfoca un proyecto.
 */
export interface ProjectContext {
  slug: string;
  ruta_local: string | null;
  /** ¿se pudo leer el repo local? (la ruta existe). */
  found: boolean;
  rama?: string;
  /** estado git del repo; null si la ruta no es un repo git. */
  git?: ProjectGit | null;
  hasClaudeMd: boolean;
  skills: ProjectSkill[];
  mcpServers: ProjectMcpServer[];
  /** permissions.allow (merge de settings.json + settings.local.json). */
  allowTools: string[];
  denyTools: string[];
  /** slash-commands en .claude/commands. */
  commands: string[];
}

/** Una línea del transcript de una corrida `claude -p` (stream-json → HUD). */
export interface ClaudeSessionLine {
  t: number;
  kind: string;
  text: string;
}

/** Campos comunes de una sesión de Claude Code (CLI) persistida por proyecto. */
export interface ClaudeSessionMeta {
  /** Id estable de la sesión (uuid, = --session-id del CLI). */
  id: string;
  projectSlug: string;
  title: string;
  model: string;
  status: "running" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}

/** Resumen para la lista de sesiones (con conteo de líneas del transcript). */
export interface ClaudeSessionSummary extends ClaudeSessionMeta {
  lineCount: number;
}

/**
 * Resumen en vivo de un run de Claude Code (proceso `claude -p` en curso o
 * recién terminado). Lo consume el panel Orquestador para listar todo lo que
 * está corriendo en todos los proyectos a la vez (endpoint GET /claude/runs).
 */
export interface ClaudeRunSummary {
  /** Id de la corrida (run.id, corto). */
  id: string;
  /** Id estable de la sesión Hermes (para reabrir su stream/terminal). */
  sessionId: string;
  projectSlug: string;
  /** Prompt recortado, como etiqueta de la fila. */
  title: string;
  status: "running" | "done" | "error";
  startedAt: string;
  model: string;
  effort: string;
  /** Nº de tool_use vistos en el transcript hasta ahora. */
  toolCalls: number;
  exitCode?: number;
  /** Costo real del run en USD (del evento result del CLI); solo al terminar. */
  costUsd?: number;
  /** Duración reportada por el CLI en ms; solo al terminar. */
  durationMs?: number;
  /** Nº de turnos del run; solo al terminar. */
  numTurns?: number;
  /** Tokens del evento result del CLI; solo al terminar. */
  usage?: RunTokenUsage;
  /** Último texto del asistente (recortado) como preview del resultado. */
  lastText?: string;
}

/** Tokens del evento result del CLI (por run y acumulado diario). */
export interface RunTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Acumulado de gasto del día en runs de Claude Code (GET /stats). */
export interface DailyRunUsage {
  /** Suma de total_cost_usd de los runs terminados hoy. */
  costUsd: number;
  /** Nº de runs terminados hoy. */
  runs: number;
  /** Suma de tokens de los runs de hoy (opcional: archivos viejos no lo traen). */
  tokens?: RunTokenUsage;
}

/** Detalle completo de una sesión de Claude Code, con su transcript. */
export interface ClaudeSessionDetail extends ClaudeSessionMeta {
  effort: string;
  permissionMode: string;
  cwd: string;
  /** Id de sesión del SDK/CLI a usar con `claude --resume` (sigue al último fork). */
  sdkSessionId: string;
  lines: ClaudeSessionLine[];
}

/** Evento del bus de actividad del agente (SSE /events + tabla agent_activity). */
export interface AgentActivityEvent {
  kind:
    | "task_start"
    | "tool_call"
    | "tool_result"
    | "text"
    | "task_done"
    | "error"
    | "session_start"
    | "browser";
  taskId?: string;
  sessionId?: string;
  toolName?: string;
  detail?: string;
  machine?: string;
  ts: string;
}

/**
 * Paso agéntico de UN turno de la consola. Viaja en el frame `hermes.tool` del
 * SSE de /v1/chat/completions — así queda correlacionado con SU request (el bus
 * global /events no distingue de qué tab salió cada tool_call).
 */
export interface ChatToolStep {
  /** Nombre crudo de la tool del SDK (Read, Grep, mcp__hermes__save_memory…). */
  name: string;
  /** Objetivo extraído del input (ruta, patrón, query…); vacío si no aplica. */
  target?: string;
}

export type TaskStatus = "running" | "done" | "error";

export interface HermesTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  /** Resumen final (último texto del asistente) cuando status === done. */
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  toolCalls: number;
}

export interface SystemVitals {
  memories: number;
  activeProjects: number;
  sessionsToday: number;
  tasksToday: number;
  machine: string;
  uptimeSeconds: number;
  supabase: boolean;
}

// ── Tareas (tracker de misión por proyecto) ────────────────────────────
// Tarea de primera clase con ciclo de vida. Verdad del ESTADO en Supabase
// (tabla `tasks`); espejo humano en "## Tareas Pendientes" de la nota del vault.

/** pending=por hacer · running=ejecutando · done=hecha · dismissed=ignorada.
 *  (distinto de TaskStatus, que es el estado de las HermesTask async del SDK). */
export type ActionableStatus = "pending" | "running" | "done" | "dismissed";
export type TaskState = ActionableStatus;

/** De dónde salió la tarea. */
export type TaskSource = "meeting" | "manual" | "vault" | "voice";

export interface Task {
  id: number;
  project_slug: string;
  title: string;
  detail?: string | null;
  /** prompt para ejecutar la tarea con `claude -p` (si aplica). */
  exec_prompt?: string | null;
  status: TaskState;
  source: TaskSource;
  /** procedencia: id de la reunión y del accionable (si source=meeting). */
  meeting_id?: string | null;
  meeting_idx?: number | null;
  /** run/sesión de Claude Code al ejecutar. */
  run_id?: string | null;
  session_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  done_at?: string | null;
}

// ── Ejecuciones de tareas (memoria de Control de Misión) ───────────────
// Cada Ejecutar/Continuar de una tarea genera un documento {prompt · análisis ·
// resultado}. Verdad = markdown en el vault (projects/<slug>/ejecuciones/<id>.md);
// espejo en Supabase (tabla task_executions). NO confundir con ClaudeRunSummary,
// que es el run EFÍMERO en memoria; esto es su contraparte DURABLE y curada.

/** Cómo se lanzó la corrida: nueva (Ejecutar) o resume (Continuar). */
export type TaskExecutionKind = "execute" | "continue";

/** Resultado de la corrida: cerró bien (done) o falló/cancelada (error). */
export type TaskExecutionStatus = "done" | "error";

/** Fila de historial: lo mínimo para listar las ejecuciones de una tarea. */
export interface TaskExecutionSummary {
  /** id = nombre del archivo del vault sin `.md` (ancla para abrir el detalle). */
  id: string;
  task_id: number | null;
  project_slug: string;
  kind: TaskExecutionKind;
  status: TaskExecutionStatus;
  /** primeras líneas del resultado, como preview de la fila. */
  result_snippet: string;
  cost_usd?: number | null;
  duration_ms?: number | null;
  created_at: string;
}

/** Documento completo de una ejecución (prompt + análisis + resultado + markdown). */
export interface TaskExecution extends TaskExecutionSummary {
  run_id: string | null;
  session_id: string | null;
  /** prompt de intención que se envió (exec_prompt o el de continuar). */
  prompt: string;
  /** narrativa del pase LLM + trace de pasos/herramientas. */
  analysis: string;
  /** resultado final (último texto del asistente, sin recorte). */
  result: string;
  /** documento markdown completo, listo para renderizar. */
  markdown: string;
  model: string;
  effort: string;
  num_turns?: number | null;
  machine?: string | null;
  /** ruta absoluta del .md en el vault. */
  vault_path?: string | null;
  finished_at?: string | null;
}

// ── Dashboard: capa de datos del rediseño ──────────────────────────────
// Endpoints nuevos del agente que alimentan el strip inferior, la presencia
// multi-Mac y los conteos del rediseño. Regla: cada sección es independiente
// y "nullable" — si su fuente falla, el resto del dashboard sigue vivo.

/** Métricas del Mac local (panel SISTEMA). Fuente: node:os + fs.statfs. */
export interface SystemMetrics {
  /** 0-100, delta de ticks de CPU desde el último sample (5s). */
  cpuPct: number;
  loadAvg1: number;
  /** 0-100 (aprox en macOS: freemem subestima lo disponible). */
  memUsedPct: number;
  memTotalBytes: number;
  memUsedBytes: number;
  /** 0-100 del volumen raíz; 0 con diskTotalBytes 0 = no disponible. */
  diskUsedPct: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  /** Uptime del Mac (no del agente). */
  uptimeOsSeconds: number;
  uptimeAgentSeconds: number;
}

/** Un bucket horario de la actividad del agente (área chart 24h). */
export interface ActivityBucket {
  /** ISO del inicio de la hora. */
  hour: string;
  total: number;
  toolCalls: number;
  /** task_start + task_done. */
  tasks: number;
  errors: number;
}

export interface ActivitySeries {
  hours: number;
  /** supabase = todas las Macs, persiste reinicios · memoria = fallback parcial. */
  source: "supabase" | "memoria";
  /** Siempre `hours` entradas; horas sin actividad van en 0. */
  buckets: ActivityBucket[];
}

/** Conteos reales de la base de conocimiento (panel MEMORIA ACTIVA). */
export interface KnowledgeStats {
  /** false = sin Supabase (todo en 0). */
  available: boolean;
  total: number;
  memories: number;
  vaultDocs: number;
  meetings: number;
  executions: number;
  conversationText: number;
  conversationVoice: number;
}

export type JobResult = "ok" | "error" | "skipped";

/** Estado de un job periódico del agente (panel AUTOMATIZACIONES). */
export interface JobStatus {
  name: string;
  intervalMs: number;
  /** null = aún no corrió desde el arranque. */
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: JobResult | null;
  /** Mensaje recortado si lastResult === "error". */
  lastError: string | null;
  /** Detalle humano de la última corrida ("3 notas vectorizadas…"). */
  lastDetail: string | null;
  nextRunAt: string | null;
  runsOk: number;
  runsError: number;
}

/** Fila del panel de agentes activos (agent_presence + estado local). */
export interface MachinePresence {
  machine: string;
  status: "idle" | "working" | "thinking" | "offline";
  currentTask: string | null;
  lastHeartbeat: string | null;
  version: string | null;
  /** Heartbeat hace menos de 90 s. */
  online: boolean;
  /** La máquina que respondió este request. */
  self: boolean;
  /**
   * URL base alcanzable en la red interna (http://192.168.1.60:8650) publicada
   * por el propio agente. El selector de máquina apunta el dashboard aquí, así
   * que null = esa máquina existe pero no se sabe cómo hablarle.
   */
  baseUrl: string | null;
  lanIp: string | null;
  /** "macOS · arm64", "Linux (WSL) · x64", "Windows · x64". */
  os: string | null;
  /** Qué puede hacer REALMENTE esa máquina (cada PC corre un subconjunto). */
  capabilities: MachineCapabilities | null;
}

/**
 * Capacidades reales de un agente. Se derivan de su entorno al latir (no son
 * flags de configuración): la UI las usa para no ofrecer en un PC algo que
 * solo existe en el otro.
 */
export interface MachineCapabilities {
  /** VAULT_PATH configurado → los proyectos escriben notas. */
  vault: boolean;
  /** Ejecuta `claude` (runs, tareas, chat con memoria de sesión). */
  runs: boolean;
  /** Grafo de código (binario de graphify presente). */
  codeGraph: boolean;
}

/** Conteos del tracker por estado (header del tablero). */
export interface TrackerSummary {
  /** false = sin Supabase. */
  available: boolean;
  pending: number;
  running: number;
  done: number;
  dismissed: number;
  /** Solo con ?byProject=1. */
  byProject?: { project_slug: string; pending: number; running: number; done: number }[];
}

/** Snapshot único del dashboard (GET /dashboard): un solo poll para el strip
 *  inferior y la presencia. Cada sección se arma con Promise.allSettled. */
export interface DashboardSnapshot {
  generatedAt: string;
  machine: string;
  system: SystemMetrics;
  presence: MachinePresence[];
  knowledge: KnowledgeStats;
  tracker: TrackerSummary;
  jobs: JobStatus[];
  activity: ActivitySeries | null;
  usage: DailyRunUsage;
}
