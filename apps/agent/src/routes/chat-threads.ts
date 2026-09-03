import type { Hono } from "hono";
import { withUser } from "../auth.js";
import {
  listThreadsMeta,
  getThread,
  upsertThread,
  deleteThread,
  getActiveChat,
  setActiveChat,
  type UpsertThreadInput,
} from "../chat-threads.js";

/**
 * Sync de chats del Laboratorio entre dispositivos — ver chat-threads.ts.
 * Scoped por `userId`, que pone en el contexto el middleware de auth de
 * index.ts SOLO cuando la credencial fue un JWT de Supabase (no la
 * HERMES_API_KEY estática de LAN). Sin userId (LAN sin login, o Supabase no
 * configurado) estas rutas responden "no hay nada"/no-op en vez de error: el
 * laboratorio sigue funcionando 100% local vía localStorage, que es su
 * comportamiento de siempre — esto es un mirror ADICIONAL, no un reemplazo.
 */
export function registerChatThreadsRoutes(app: Hono): void {
  app.get("/chat/threads", async (c) => {
    const userId = withUser(c).get("userId");
    const project = c.req.query("project") || "general";
    if (!userId) return c.json({ threads: [], activeId: null });
    const [threads, activeId] = await Promise.all([
      listThreadsMeta(userId, project),
      getActiveChat(userId, project),
    ]);
    return c.json({ threads, activeId });
  });

  app.get("/chat/threads/:id", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ error: "not-found" }, 404);
    const thread = await getThread(userId, c.req.param("id"));
    if (!thread) return c.json({ error: "not-found" }, 404);
    return c.json(thread);
  });

  app.put("/chat/threads/:id", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ ok: false });
    const body = await c.req.json<UpsertThreadInput>().catch(() => null);
    if (!body) return c.json({ error: "body inválido" }, 400);
    await upsertThread(userId, c.req.param("id"), body);
    return c.json({ ok: true });
  });

  app.delete("/chat/threads/:id", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ ok: true });
    await deleteThread(userId, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.put("/chat/active", async (c) => {
    const userId = withUser(c).get("userId");
    if (!userId) return c.json({ ok: false });
    const body = await c.req.json<{ project?: string; chatId?: string }>().catch(() => null);
    if (!body?.chatId) return c.json({ error: "chatId requerido" }, 400);
    await setActiveChat(userId, body.project || "general", body.chatId);
    return c.json({ ok: true });
  });
}
