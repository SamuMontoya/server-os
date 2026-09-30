import type { Hono } from "hono";
import { withUser } from "../auth.js";
import {
  listFeedback,
  createFeedback,
  updateFeedbackStatus,
  deleteFeedback,
  type FeedbackStatus,
  type FeedbackPriority,
} from "../feedback.js";

/**
 * Buzón de mejoras — CENTRALIZADO: "todos los que tengan acceso a este
 * portal" (pedido de Jaime 2026-09-30) ven y pueden mover de estado
 * CUALQUIER reporte, no solo el que crearon — a diferencia de
 * registerChatThreadsRoutes, que sí es privado por userId. Se exige sesión
 * (userId en el contexto) igual que el resto de rutas — sin ella, mismo
 * no-op que chat-threads (LAN con API key estática, sin login).
 * Excepción: PATCH a status="completado" exige que el JWT pertenezca a
 * samu7montoya@gmail.com — es la única acción con dueño único del buzón.
 * DELETE sí queda scoped al creador (ver deleteFeedback en ../feedback.ts).
 */
const EMAIL_CIERRE = "samu7montoya@gmail.com";
const STATUSES: FeedbackStatus[] = ["abierto", "en_revision", "completado"];

export function registerFeedbackRoutes(app: Hono): void {
  app.get("/feedback", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ items: [] });
    const project = c.req.query("project") || "general";
    const statusParam = c.req.query("status");
    const status = STATUSES.includes(statusParam as FeedbackStatus)
      ? (statusParam as FeedbackStatus)
      : undefined;
    try {
      const items = await listFeedback(project, status);
      return c.json({ items });
    } catch (err) {
      console.error("[feedback] GET error:", err);
      return c.json({ error: "no se pudo listar el feedback" }, 500);
    }
  });

  app.post("/feedback", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const { title, description, images } = body ?? {};
    const priority: FeedbackPriority = [1, 2, 3].includes(body?.priority) ? body.priority : 2;
    if (!title || typeof title !== "string" || !title.trim()) {
      return c.json({ error: "falta el título" }, 400);
    }
    if (!description || typeof description !== "string" || !description.trim()) {
      return c.json({ error: "falta la descripción" }, 400);
    }
    const project = c.req.query("project") || "general";
    try {
      const feedback = await createFeedback(
        userId,
        project,
        title.trim(),
        description.trim(),
        priority,
        Array.isArray(images) ? images : undefined,
      );
      return c.json({ ok: true, feedback }, 201);
    } catch (err) {
      console.error("[feedback] POST error:", err);
      return c.json({ error: "no se pudo crear el reporte" }, 500);
    }
  });

  app.patch("/feedback/:id", async (c) => {
    const ctx = withUser(c);
    const userId = ctx.get("userId");
    const userEmail = (ctx.get("userEmail") || "").toLowerCase();
    const feedbackId = c.req.param("id");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const status = body?.status as FeedbackStatus;
    if (!STATUSES.includes(status)) {
      return c.json({ error: "status inválido" }, 400);
    }
    if (status === "completado" && userEmail !== EMAIL_CIERRE) {
      return c.json({ error: `solo ${EMAIL_CIERRE} puede marcar como completado` }, 403);
    }
    try {
      const feedback = await updateFeedbackStatus(feedbackId, status, userId);
      if (!feedback) return c.json({ error: "reporte no encontrado" }, 404);
      return c.json({ ok: true, feedback });
    } catch (err) {
      console.error("[feedback] PATCH error:", err);
      return c.json({ error: "no se pudo actualizar el reporte" }, 500);
    }
  });

  app.delete("/feedback/:id", async (c) => {
    const userId = withUser(c).get("userId");
    const feedbackId = c.req.param("id");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    try {
      await deleteFeedback(feedbackId, userId);
      return c.json({ ok: true });
    } catch (err) {
      console.error("[feedback] DELETE error:", err);
      return c.json({ error: "no se pudo borrar el reporte" }, 500);
    }
  });
}
