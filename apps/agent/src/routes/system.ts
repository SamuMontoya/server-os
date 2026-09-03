import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { env } from "../env.js";
import { activityHourly, recentEvents, subscribe } from "../events.js";
import { getPresence, listPresence, selfBaseUrl } from "../presence.js";
import { readProjects } from "../vault/projects.js";
import { memoriesCount, hasSupabase } from "../memory.js";
import { knowledgeStats } from "../knowledge.js";
import { getSystemMetrics } from "../system.js";
import { listJobs } from "../jobs.js";
import { listTasks } from "../agent/session.js";
import { getDailyUsage } from "../usage.js";
import { trackerSummary } from "../tasks/store.js";

const startedAt = Date.now();

export function registerSystemRoutes(app: Hono): void {
  app.get("/health", (c) =>
    c.json({
      ok: true,
      machine: env.MACHINE_NAME,
      // El selector de máquina sondea /health (sin auth) para saber a quién le
      // está hablando: sin el nombre, dos agentes de la LAN son indistinguibles.
      baseUrl: selfBaseUrl(),
      uptime: (Date.now() - startedAt) / 1000,
    }),
  );

  // ── Stream de actividad en vivo (dashboard) ────────────────────────────
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      for (const ev of recentEvents().slice(-30)) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
      let open = true;
      const unsubscribe = subscribe((ev) => {
        if (open) void stream.writeSSE({ data: JSON.stringify(ev) });
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      // Heartbeat para mantener viva la conexión
      while (open) {
        await new Promise((r) => setTimeout(r, 15000));
        if (open) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
    }),
  );

  // ── Vitals para el dashboard ───────────────────────────────────────────
  app.get("/stats", async (c) => {
    const projects = await readProjects();
    const tasks = listTasks();
    const today = new Date().toISOString().slice(0, 10);
    const dailyUsage = await getDailyUsage();
    return c.json({
      memories: await memoriesCount(),
      activeProjects: projects.filter((p) => p.estado === "activo").length,
      totalProjects: projects.length,
      sessionsToday: tasks.filter((t) => t.startedAt.startsWith(today)).length,
      tasksToday: tasks.filter((t) => t.startedAt.startsWith(today)).length,
      // Gasto real del día en runs de Claude Code (acumulador persistente).
      dailyRunCostUsd: dailyUsage.costUsd,
      runsToday: dailyUsage.runs,
      machine: env.MACHINE_NAME,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      supabase: hasSupabase(),
      presence: getPresence(),
    });
  });

  // ── Datos del dashboard (rediseño) ─────────────────────────────────────
  // Regla: nunca 500 — cada fuente degrada a su fallback y el panel del front
  // se auto-oculta o muestra su CTA.

  // Métricas del Mac local (CPU/RAM/disco/uptime).
  app.get("/system", async (c) =>
    c.json(await getSystemMetrics(Math.floor((Date.now() - startedAt) / 1000))),
  );

  // Presencia de TODAS las Macs (agent_presence + estado local exacto).
  app.get("/presence", async (c) => c.json(await listPresence()));

  // Máquinas de la red interna: la misma presencia, pero pensada para el selector
  // del dashboard (quién está vivo, cómo se le habla y qué puede hacer). Es una
  // ruta propia porque el selector la pide antes de que cargue nada más.
  app.get("/machines", async (c) => c.json({ machines: await listPresence() }));

  // Estado de los jobs periódicos (panel AUTOMATIZACIONES).
  app.get("/jobs", (c) => c.json(listJobs()));

  // Serie horaria de actividad (área chart 24h).
  app.get("/activity/hourly", async (c) =>
    c.json(await activityHourly(Math.min(Number(c.req.query("hours")) || 24, 168))),
  );

  // Agregador: UN solo poll para todo el strip inferior + presencia. Cada
  // sección es independiente (allSettled): si una fuente falla, llega null o
  // su fallback y el resto vive.
  app.get("/dashboard", async (c) => {
    const uptimeAgent = Math.floor((Date.now() - startedAt) / 1000);
    const [system, presence, knowledge, tracker, activity, usage] =
      await Promise.allSettled([
        getSystemMetrics(uptimeAgent),
        listPresence(),
        knowledgeStats(),
        trackerSummary(),
        activityHourly(24),
        getDailyUsage(),
      ]);
    const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;
    return c.json({
      generatedAt: new Date().toISOString(),
      machine: env.MACHINE_NAME,
      system: val(system, {
        cpuPct: 0,
        loadAvg1: 0,
        memUsedPct: 0,
        memTotalBytes: 0,
        memUsedBytes: 0,
        diskUsedPct: 0,
        diskTotalBytes: 0,
        diskFreeBytes: 0,
        uptimeOsSeconds: 0,
        uptimeAgentSeconds: uptimeAgent,
      }),
      presence: val(presence, []),
      knowledge: val(knowledge, {
        available: false,
        total: 0,
        memories: 0,
        vaultDocs: 0,
        meetings: 0,
        executions: 0,
        conversationText: 0,
        conversationVoice: 0,
      }),
      tracker: val(tracker, {
        available: false,
        pending: 0,
        running: 0,
        done: 0,
        dismissed: 0,
      }),
      jobs: listJobs(),
      activity: val(activity, null),
      usage: val(usage, { costUsd: 0, runs: 0 }),
    });
  });
}
