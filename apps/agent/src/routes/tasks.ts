import type { Hono } from "hono";
import { getTask, listTasks, startTask } from "../agent/session.js";

export function registerTasksRoutes(app: Hono): void {
  // ── Tareas async (voz → run_task / check_task) ─────────────────────────
  app.post("/tasks", async (c) => {
    const { prompt } = await c.req.json<{ prompt?: string }>();
    if (!prompt) return c.json({ error: "prompt requerido" }, 400);
    const task = startTask(prompt);
    return c.json({ task_id: task.id, status: task.status });
  });

  app.get("/tasks", (c) => c.json(listTasks().slice(0, 20)));

  app.get("/tasks/:id", (c) => {
    const task = getTask(c.req.param("id"));
    if (!task) return c.json({ error: "task no encontrada" }, 404);
    return c.json(task);
  });
}
