import type { Hono } from "hono";
import { readProjects } from "../vault/projects.js";
import { readProjectContext } from "../vault/project-context.js";
import { resolveVaultDoc } from "../vault/doc.js";

export function registerVaultRoutes(app: Hono): void {
  app.get("/projects", async (c) => c.json(await readProjects()));

  // Resuelve un .md del vault desde una referencia (wikilink `[[x]]` o ruta `x.md`)
  // para el visor tipo Notion del dashboard. `project` desambigua nombres repetidos.
  app.get("/vault/doc", async (c) =>
    c.json(await resolveVaultDoc(c.req.query("ref") ?? "", c.req.query("project") || undefined)),
  );

  // Contexto operativo de un proyecto (skills · MCP · tools · comandos).
  app.get("/projects/:slug/context", async (c) =>
    c.json(await readProjectContext(c.req.param("slug"))),
  );
}
