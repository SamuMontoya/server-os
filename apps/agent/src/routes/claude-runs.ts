import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { emit } from "../events.js";
import { readProjects, resolveProjectRoot } from "../vault/projects.js";
import {
  startClaudeRun,
  getClaudeRun,
  listClaudeRuns,
  killClaudeRun,
  subscribeClaudeRun,
  type ClaudeLine,
} from "../agent/claude-cli.js";
import { getClaudeLimits } from "../claude-limits.js";
import { getClaudeUsage } from "../claude-usage.js";
import {
  listClaudeSessions,
  getClaudeSession,
  deleteClaudeSession,
} from "../agent/claude-sessions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Claude Code (CLI real): panel embebido headless ────────────────────
interface ClaudeExecBody {
  prompt?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  project?: string;
  /** Si viene, se resume esa sesión de Claude Code en vez de crear una nueva. */
  resumeSessionId?: string;
}

export function registerClaudeRunsRoutes(app: Hono): void {
  // Inicia una corrida headless de `claude -p` y transmite por SSE al panel.
  app.post("/claude/run", async (c) => {
    const b = await c.req.json<ClaudeExecBody>().catch(() => ({}) as ClaudeExecBody);
    if (!b.prompt?.trim()) return c.json({ error: "prompt requerido" }, 400);

    const projectSlug = b.project || "general";

    // Resume una sesión existente, o crea una nueva con un id fresco.
    // resumeSessionId viene del cliente → se exige formato uuid antes de pasarlo
    // a `claude --resume` (evita que un valor con "-" se cuele como flag del CLI).
    let sessionId: string;
    let resumeSdkSessionId: string | undefined;
    let existing: Awaited<ReturnType<typeof getClaudeSession>> = null;
    if (b.resumeSessionId && UUID_RE.test(b.resumeSessionId)) {
      sessionId = b.resumeSessionId;
      existing = await getClaudeSession(projectSlug, b.resumeSessionId);
      // sdkSessionId sale del CLI/nuestro uuid; validado también por si acaso.
      const candidate = existing?.sdkSessionId ?? b.resumeSessionId;
      resumeSdkSessionId = UUID_RE.test(candidate) ? candidate : b.resumeSessionId;
    } else {
      sessionId = randomUUID();
    }

    // cwd: al resumir, la MISMA carpeta con que se creó la sesión (así el CLI la
    // encuentra aunque cambie el ruta_local); si no, el repo local del proyecto.
    let cwd: string | undefined = existing?.cwd || undefined;
    if (!cwd && b.project) {
      const p = (await readProjects()).find(
        (x) => x.slug.toLowerCase() === b.project!.toLowerCase(),
      );
      // resolveProjectRoot, no ruta_local a secas: en otra máquina el mismo
      // proyecto vive en otra carpeta (y correr en el cwd equivocado es peor
      // que no correr).
      if (p) cwd = resolveProjectRoot(p) ?? undefined;
    }

    const run = startClaudeRun({
      prompt: b.prompt,
      model: b.model,
      effort: b.effort,
      permissionMode: b.permissionMode,
      projectContext: b.project,
      cwd,
      projectSlug,
      sessionId,
      resumeSdkSessionId,
    });
    emit({
      kind: "task_start",
      taskId: run.id,
      detail: `claude -p${resumeSdkSessionId ? " (resume)" : ""}: ${b.prompt.slice(0, 100)}`,
    });
    return c.json({
      run_id: run.id,
      session_id: sessionId,
      status: run.status,
      model: run.model,
      effort: run.effort,
      permissionMode: run.permissionMode,
    });
  });

  // Runs de Claude Code vivos (en curso o recién terminados) de TODOS los
  // proyectos → panel Orquestador del dashboard.
  app.get("/claude/runs", (c) => c.json(listClaudeRuns()));

  // Cancela un run en curso (botón ✕ del Orquestador).
  app.post("/claude/run/:id/kill", (c) => {
    const res = killClaudeRun(c.req.param("id"));
    if (res.ok) emit({ kind: "tool_call", toolName: "claude(kill)", detail: c.req.param("id") });
    return c.json(res, res.ok ? 200 : 400);
  });

  // ── Sesiones de Claude Code (CLI) por proyecto: listar · leer · borrar ──
  app.get("/claude/sessions/:project", async (c) =>
    c.json(await listClaudeSessions(c.req.param("project"))),
  );

  app.get("/claude/sessions/:project/:id", async (c) => {
    const session = await getClaudeSession(c.req.param("project"), c.req.param("id"));
    if (!session) return c.json({ error: "sesión no encontrada" }, 404);
    return c.json(session);
  });

  app.delete("/claude/sessions/:project/:id", async (c) => {
    await deleteClaudeSession(c.req.param("project"), c.req.param("id"));
    return c.json({ ok: true });
  });

  // SSE del stream de una corrida embebida (replay + live).
  app.get("/claude/run/:id/stream", (c) => {
    const id = c.req.param("id");
    const run = getClaudeRun(id);
    if (!run) return c.json({ error: "run no encontrada" }, 404);

    return streamSSE(c, async (stream) => {
      let queue: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        queue = queue.then(() =>
          stream.writeSSE({ event, data: typeof data === "string" ? data : JSON.stringify(data) }),
        );
        return queue;
      };

      let ended = false;
      const finish = async () => {
        if (ended) return;
        ended = true;
        const cur = getClaudeRun(id) ?? run;
        await send("status", { status: cur.status, exitCode: cur.exitCode });
        await send("end", "[DONE]");
      };
      const isTerminal = (line: ClaudeLine) =>
        (line.kind === "done" || line.kind === "error") && line.text.includes("finalizó");

      // Snapshot del buffer + suscripción en el MISMO tick (sin await entre medias)
      // → ni el shift() del buffer ni la ventana de replay pierden líneas.
      const snapshot = [...run.lines];
      const pending: ClaudeLine[] = [];
      let replaying = true;
      let unsub: (() => void) | null = null;

      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          unsub?.();
          resolve();
        };
        const handle = (line: ClaudeLine) => {
          void send("line", line);
          if (isTerminal(line)) void finish().then(settle);
        };

        unsub = subscribeClaudeRun(id, (line) => {
          if (replaying) pending.push(line);
          else handle(line);
        });
        c.req.raw.signal.addEventListener("abort", settle);

        void (async () => {
          for (const line of snapshot) await send("line", line);
          replaying = false;
          for (const line of pending) handle(line);
          pending.length = 0;
          // Si sigue viva, el subscriber cerrará al ver la línea terminal.
          const cur = getClaudeRun(id) ?? run;
          if (cur.status === "running") return;
          await finish(); // idempotente
          settle();
        })();
      });
      await finish();
    });
  });

  // Límites del plan de Claude Code (ventana de 5h + semanales) y uso histórico
  // agregado de ~/.claude/projects — la web (Vercel, sin este disco) los
  // consume vía proxy en /api/claude-limits y /api/claude-usage.
  app.get("/claude/limits", async (c) => c.json(await getClaudeLimits()));
  app.get("/claude/usage", async (c) => c.json(await getClaudeUsage()));
}
