import type { Hono } from "hono";
import { withUser } from "../auth.js";
import {
  listAllMemories,
  updateMemoryContent,
  deleteMemoryById,
  listAllPreferences,
  savePreference,
  deletePreferenceByKey,
} from "../memory.js";
import { resetSystemPromptCache } from "../agent/system-prompt.js";

/**
 * Panel "Memoria y preferencias" del portal (pedido de Jaime 2026-10-02):
 * hasta ahora lo que el agente aprendía (save_memory/save_preference) era
 * invisible — ni se podía ver, editar ni borrar salvo pidiéndoselo al agente
 * por chat. Estas rutas alimentan la pantalla dedicada, visible para
 * CUALQUIER usuario con acceso al portal (igual que el Buzón de mejoras,
 * A4 del backlog) — no es exclusivo de Jaime.
 *
 * Toda escritura (PATCH/DELETE) invalida el cache del system prompt, igual
 * que save_memory/save_preference en agent/tools.ts — si no, el panel diría
 * "editado" pero el agente seguiría sirviendo el prompt viejo hasta una hora
 * después (el mismo bug que motivó este trabajo).
 */
export function registerLearningRoutes(app: Hono): void {
  app.get("/memories", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ items: [] });
    try {
      const items = await listAllMemories();
      // Agrupadas por proyecto en el payload (A5: "agrupadas por proyecto, no
      // todo junto con filtro") — el frontend solo pinta, no decide el grouping.
      const grouped: Record<string, typeof items> = {};
      for (const m of items) {
        const key = m.project_slug || "_sin_proyecto";
        (grouped[key] ??= []).push(m);
      }
      return c.json({ items, grouped });
    } catch (err) {
      console.error("[learning] GET /memories error:", err);
      return c.json({ error: "no se pudieron listar las memorias" }, 500);
    }
  });

  app.patch("/memories/:id", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return c.json({ error: "falta el contenido" }, 400);
    try {
      const ok = await updateMemoryContent(id, content);
      if (!ok) return c.json({ error: "no se pudo editar la memoria" }, 500);
      resetSystemPromptCache();
      return c.json({ ok: true });
    } catch (err) {
      console.error("[learning] PATCH /memories error:", err);
      return c.json({ error: "no se pudo editar la memoria" }, 500);
    }
  });

  app.delete("/memories/:id", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    try {
      const ok = await deleteMemoryById(id);
      if (!ok) return c.json({ error: "no se pudo borrar la memoria" }, 500);
      resetSystemPromptCache();
      return c.json({ ok: true });
    } catch (err) {
      console.error("[learning] DELETE /memories error:", err);
      return c.json({ error: "no se pudo borrar la memoria" }, 500);
    }
  });

  app.get("/preferences", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ items: [] });
    try {
      const items = await listAllPreferences();
      return c.json({ items });
    } catch (err) {
      console.error("[learning] GET /preferences error:", err);
      return c.json({ error: "no se pudieron listar las preferencias" }, 500);
    }
  });

  app.patch("/preferences/:key", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => ({}));
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (!value) return c.json({ error: "falta el valor" }, 400);
    try {
      const result = await savePreference(key, value);
      if (result.startsWith("Error")) return c.json({ error: result }, 500);
      resetSystemPromptCache();
      return c.json({ ok: true });
    } catch (err) {
      console.error("[learning] PATCH /preferences error:", err);
      return c.json({ error: "no se pudo editar la preferencia" }, 500);
    }
  });

  app.delete("/preferences/:key", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const key = c.req.param("key");
    try {
      const ok = await deletePreferenceByKey(key);
      if (!ok) return c.json({ error: "no se pudo borrar la preferencia" }, 500);
      resetSystemPromptCache();
      return c.json({ ok: true });
    } catch (err) {
      console.error("[learning] DELETE /preferences error:", err);
      return c.json({ error: "no se pudo borrar la preferencia" }, 500);
    }
  });
}
