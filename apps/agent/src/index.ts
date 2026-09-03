import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { EMB } from "./embeddings.js";
import { modelSummary } from "./agent/models.js";
import { budgetState } from "./agent/budget.js";
import { verifySupabaseToken } from "./auth.js";
import { pushPresence } from "./presence.js";
import { readProjects } from "./vault/projects.js";
import { hasSupabase } from "./memory.js";
import { syncVaultKnowledge } from "./vault/knowledge-sync.js";
import { startSystemSampler } from "./system.js";
import { registerJob } from "./jobs.js";
import { reconcileRunningTasks } from "./tasks/store.js";
import { relojRapido } from "./watch/rapido.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerWatchRoutes } from "./routes/watch.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { registerTrackerRoutes } from "./routes/tracker.js";
import { registerClaudeRunsRoutes } from "./routes/claude-runs.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerSystemRoutes } from "./routes/system.js";

const app = new Hono();

// Orígenes permitidos: loopback, IPs privadas de la LAN, la malla de Tailscale
// y nombres mDNS (.local).
// Multi-máquina: el dashboard lo sirve UNA máquina y los browsers del resto de
// la red lo cargan desde http://192.168.x.x:31415 — con el allowlist viejo (solo
// localhost) el preflight moría y no había dashboard desde otro PC.
//
// MagicDNS usa DOS etiquetas: <host>.<tailnet>.ts.net. Con `[a-z0-9-]+` solo
// entraba UNA, así que `kreanding.tail7f2dbf.ts.net` —el origen real del
// dashboard— quedaba fuera y el navegador bloqueaba cada llamada al agente.
// Se veía como "Desconectado" y "Load failed" con TODO respondiendo por curl,
// porque curl no manda Origin. De ahí el `(?:[a-z0-9-]+\.)+`.
//
// 100.64.0.0/10 es el rango CGNAT que usa Tailscale. Faltaba: el allowlist ya
// aceptaba los nombres MagicDNS (*.ts.net) pero NO las IPs crudas de la malla,
// así que abrir el dashboard en http://100.x.x.x:31415 cargaba la página y
// luego mostraba "Desconectado" — el preflight al agente moría en CORS. El
// segundo octeto va de 64 a 127.
const LAN_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|(?:[a-z0-9-]+\.)+(?:local|ts\.net))(?::\d+)?$/i;

// Portal separado en un host público (Vercel u otro): solo los orígenes
// EXACTOS de HERMES_PORTAL_ORIGINS pasan — a diferencia de la LAN/Tailscale
// de arriba, aquí no hay rango que reconocer, así que no se acepta por patrón.
const PORTAL_ORIGINS = new Set(env.PORTAL_ORIGINS);

// Private Network Access: Chrome exige que un preflight que va de una IP
// privada a loopback lo autorice explícitamente. Se responde ANTES del cors
// (que corta el OPTIONS) y se escribe sobre c.res, igual que hace el propio
// middleware de Hono.
app.use("*", async (c, next) => {
  await next();
  if (c.req.header("Access-Control-Request-Private-Network")) {
    c.res.headers.set("Access-Control-Allow-Private-Network", "true");
  }
});

app.use(
  "*",
  cors({
    origin: (origin) =>
      !origin || LAN_ORIGIN.test(origin) || PORTAL_ORIGINS.has(origin) ? origin : "",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Hermes-Session-Id",
      "X-Hermes-Project",
      "X-Hermes-Resume",
    ],
  }),
);

// Access log a stdout (launchd lo captura en ~/.hermes-os/logs/agent.log).
// Registra mutaciones (POST/PUT/DELETE) y cualquier error (4xx/5xx); los GET
// 2xx de polling se omiten para no inundar el log. Clave para forense de
// uploads del móvil: sin esto, un "Network request failed" del teléfono no
// deja rastro de si el request llegó o no.
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  const method = c.req.method;
  const status = c.res.status;
  if (method === "OPTIONS" || c.req.path === "/events") return;
  if ((method === "GET" || method === "HEAD") && status < 400) return;
  const len = c.req.header("content-length");
  const size = len ? ` ${(Number(len) / 1024 / 1024).toFixed(1)}MB` : "";
  console.log(
    `[http] ${new Date().toISOString()} ${method} ${c.req.path} → ${status} ${Date.now() - t0}ms${size}`,
  );
});

// Bearer opcional: solo se exige si HERMES_API_KEY está configurada (multi-Mac
// vía Tailscale). Los SSE usan EventSource, que no puede mandar headers → en
// rutas GET se acepta también el token como query ?key=. Además del API key
// estático se acepta un access token de Supabase Auth (login email+contraseña
// de la app móvil, que llega por el túnel cloudflared).
app.use("*", async (c, next) => {
  if (env.HERMES_API_KEY && c.req.path !== "/health") {
    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const queryKey = c.req.method === "GET" ? (c.req.query("key") ?? "") : "";
    const staticOk = bearer === env.HERMES_API_KEY || queryKey === env.HERMES_API_KEY;
    if (!staticOk) {
      const userId = await verifySupabaseToken(bearer || queryKey);
      if (!userId) return c.json({ error: "unauthorized" }, 401);
    }
  }
  await next();
});

// ── Rutas ────────────────────────────────────────────────────────────────
// Cada dominio vive en su propio módulo bajo ./routes; todos registran sobre
// el MISMO `app` (nada de sub-routers montados con prefijo), así que el orden
// de registro entre módulos no cambia el comportamiento de matching de Hono:
// es exactamente la misma secuencia de app.get/post/... que antes vivía toda
// junta acá, solo que repartida por archivo.
registerSystemRoutes(app); // /health, /events, /stats, /system, /presence, /machines, /jobs, /activity/hourly, /dashboard
registerChatRoutes(app); // /v1/chat/completions, /chat/*, /conversations/*, /dictado/transcribir
registerWatchRoutes(app); // /watch/*, /limits
registerTasksRoutes(app); // /tasks* (SDK async, voz)
registerTrackerRoutes(app); // /tracker/*
registerClaudeRunsRoutes(app); // /claude/run*, /claude/sessions/*, /claude/limits, /claude/usage
registerKnowledgeRoutes(app); // /knowledge/*, /memories/recent
registerVaultRoutes(app); // /projects*, /vault/doc

// ── Boot ───────────────────────────────────────────────────────────────
startSystemSampler(); // sampler de CPU (5s) para GET /system
void readProjects(); // primer parse + sync a projects_cache
void reconcileRunningTasks(); // arregla tareas 'running' huérfanas de un reinicio

// Jobs periódicos con estado observable (GET /jobs → panel AUTOMATIZACIONES).
// Presencia: latido para que otras Macs sepan que estamos vivos.
registerJob("presence-heartbeat", 30_000, pushPresence, () =>
  hasSupabase() ? "latido enviado" : null,
);
// Índice semántico del vault: por hash — si nada cambió, 0 llamadas a OpenAI.
registerJob("vault-knowledge-sync", 10 * 60_000, syncVaultKnowledge, (r) =>
  r ? `${r.indexed} notas vectorizadas, ${r.removed} eliminadas (${r.scanned} escaneadas)` : null,
);
// Bind explícito: sin API key SOLO loopback (antes escuchaba en todas las
// interfaces con la LAN sin auth); con key se abre a 0.0.0.0 para que otra
// Mac llegue por Tailscale con Bearer/?key=.
const hostname = env.HERMES_API_KEY ? "0.0.0.0" : "127.0.0.1";
serve({ fetch: app.fetch, port: env.PORT, hostname }, (info) => {
  console.log(`\n⚡ Hermes agent server → http://localhost:${info.port}`);
  console.log(
    env.HERMES_API_KEY
      ? "   modo: RED (0.0.0.0) con HERMES_API_KEY — accesible vía Tailscale"
      : "   modo: solo esta máquina (127.0.0.1)",
  );
  console.log(`   vault: ${env.VAULT_PATH || "(sin configurar)"}`);
  console.log(`   supabase: ${hasSupabase() ? "conectado" : "no configurado"}`);
  console.log(`   embeddings: ${EMB.provider} (${EMB.dims}d → ${EMB.col})`);
  // La política de modelos, explícita: qué rol usa qué. Sin esto, saber por
  // qué un turno salió caro obliga a leer el .env y tres archivos.
  console.log(`   modelos: ${modelSummary()}`);
  // El modo de consumo, visible al arrancar: si el agente responde más corto
  // de lo normal, esta línea es la explicación.
  void budgetState().then((b) =>
    console.log(
      `   consumo: ${b.mode}${b.sessionUtilization != null ? ` (sesión ${b.sessionUtilization}%)` : ""} — ${b.reason}`,
    ),
  );
});

// El proceso del CLI del reloj se levanta AL ARRANCAR, no en la primera
// pregunta: así el primer dictado del día ya lo encuentra caliente en vez de
// pagar los ~5 s de arranque justo cuando alguien está mirando la muñeca.
relojRapido.calentar();
