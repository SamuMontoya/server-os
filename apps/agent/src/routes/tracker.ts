import type { Hono } from "hono";
import type { TaskState } from "@hermes/shared";
import {
  listTasks as listTrackerTasks,
  createTask,
  getTask as getTrackerTask,
  updateTask,
  setTaskStatus,
  importVaultTasks,
  executeTask,
  continueTask,
  reconcileRunningTasks,
  trackerSummary,
} from "../tasks/store.js";
import { listExecutions, getExecution } from "../tasks/executions.js";

export function registerTrackerRoutes(app: Hono): void {
  // ── Tracker de tareas por proyecto ─────────────────────────────────────
  // Prefijo /tracker para no chocar con /tasks (tareas async del SDK/voz).

  app.get("/tracker/tasks", async (c) =>
    c.json(
      await listTrackerTasks({
        project: c.req.query("project") || undefined,
        status: (c.req.query("status") as TaskState) || undefined,
      }),
    ),
  );

  app.post("/tracker/tasks", async (c) => {
    const { project, title, detail } = await c.req
      .json<{ project?: string; title?: string; detail?: string }>()
      .catch(() => ({ project: undefined, title: undefined, detail: undefined }));
    if (!project || !title?.trim()) return c.json({ error: "project y title requeridos" }, 400);
    return c.json(await createTask({ project, title: title.trim(), detail, source: "manual" }));
  });

  app.get("/tracker/tasks/:id", async (c) => {
    const task = await getTrackerTask(Number(c.req.param("id")));
    if (!task) return c.json({ error: "tarea no encontrada" }, 404);
    return c.json(task);
  });

  app.post("/tracker/tasks/:id", async (c) => {
    const patch = await c.req.json<{ title?: string; detail?: string }>().catch(() => ({}));
    return c.json(await updateTask(Number(c.req.param("id")), patch));
  });

  app.post("/tracker/tasks/:id/status", async (c) => {
    const { status } = await c.req.json<{ status?: TaskState }>().catch(() => ({ status: undefined }));
    if (!status) return c.json({ error: "status requerido" }, 400);
    return c.json(await setTaskStatus(Number(c.req.param("id")), status));
  });

  app.post("/tracker/tasks/:id/execute", async (c) => {
    const res = await executeTask(Number(c.req.param("id")));
    if (!res) return c.json({ error: "no se pudo ejecutar (sin tarea o sin Supabase)" }, 400);
    return c.json({ run_id: res.runId, session_id: res.sessionId, slug: res.slug });
  });

  // Continuar/enviar otro prompt: resume la sesión de la tarea con un run nuevo.
  app.post("/tracker/tasks/:id/continue", async (c) => {
    const { prompt } = await c.req.json<{ prompt?: string }>().catch(() => ({ prompt: undefined }));
    const res = await continueTask(Number(c.req.param("id")), prompt);
    if (!res) return c.json({ error: "no se pudo continuar (sin tarea o sin Supabase)" }, 400);
    return c.json({ run_id: res.runId, session_id: res.sessionId, slug: res.slug });
  });

  // Historial de ejecuciones de una tarea (memoria: prompt · análisis · resultado).
  app.get("/tracker/tasks/:id/executions", async (c) => {
    const task = await getTrackerTask(Number(c.req.param("id")));
    if (!task) return c.json({ error: "tarea no encontrada" }, 404);
    return c.json(await listExecutions(task.project_slug, task.id));
  });

  // Documento completo de una ejecución (con markdown para renderizar en la web).
  app.get("/tracker/executions/:project/:id", async (c) => {
    const exec = await getExecution(c.req.param("project"), c.req.param("id"));
    if (!exec) return c.json({ error: "ejecución no encontrada" }, 404);
    return c.json(exec);
  });

  app.post("/tracker/import/:project", async (c) =>
    c.json(await importVaultTasks(c.req.param("project"))),
  );

  // Arregla tareas 'running' huérfanas (run muerto por reinicio del agente).
  app.post("/tracker/reconcile", async (c) => c.json({ fixed: await reconcileRunningTasks() }));

  // Conteos del tracker por estado (+ ?project= y ?byProject=1).
  app.get("/tracker/summary", async (c) =>
    c.json(
      await trackerSummary({
        project: c.req.query("project") || undefined,
        byProject: c.req.query("byProject") === "1",
      }),
    ),
  );
}
