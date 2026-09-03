import type { Hono } from "hono";
import { searchKnowledge, knowledgeStats } from "../knowledge.js";
import { recentMemories } from "../memory.js";

export function registerKnowledgeRoutes(app: Hono): void {
  // Búsqueda unificada para el dashboard / debugging (mismos filtros que la tool).
  app.post("/knowledge/search", async (c) => {
    type KnowledgeSearchBody = { query?: string; sources?: string[]; project?: string; limit?: number };
    const body = await c.req.json<KnowledgeSearchBody>().catch(() => ({}) as KnowledgeSearchBody);
    if (!body.query) return c.json({ error: "query requerido" }, 400);
    const hits = await searchKnowledge(body.query, {
      sources: body.sources as never,
      project: body.project,
      limit: body.limit,
    });
    return c.json(hits);
  });

  app.get("/memories/recent", async (c) => c.json(await recentMemories(12)));

  // Conteos reales de la base de conocimiento (panel MEMORIA ACTIVA).
  app.get("/knowledge/stats", async (c) => c.json(await knowledgeStats()));
}
