/**
 * Contrato HTTP de `/feedback*` — mismo espíritu que routes/chat-threads.test.ts:
 * sin costura de inyección de Supabase a nivel de ruta (feedback.ts cae al
 * singleton real, que es `null` en este entorno de test sin .env), así que
 * acá se prueban:
 *   1) los caminos "sin userId" (no-op / 401, según el método — igual que
 *      chat-threads.ts: GET no revienta, mutaciones si exigen sesión);
 *   2) la puerta de "solo samu7montoya@gmail.com completa" en PATCH, que es
 *      pura lógica de ruta y no toca Supabase — se puede probar de punta a
 *      punta inyectando `userId`/`userEmail` en el contexto ANTES de
 *      registrar las rutas, con un middleware de prueba;
 *   3) validaciones de body (400) que tampoco tocan Supabase.
 *
 * La lógica de negocio con datos de verdad (crear/listar/actualizar/borrar)
 * vive en ../feedback.test.ts, con un doble de Supabase inyectado.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { withUser } from "../auth.js";
import { registerFeedbackRoutes } from "./feedback.js";

function buildApp(user?: { userId: string; userEmail?: string }): Hono {
  const app = new Hono();
  if (user) {
    app.use("*", async (c, next) => {
      withUser(c).set("userId", user.userId);
      if (user.userEmail) withUser(c).set("userEmail", user.userEmail);
      await next();
    });
  }
  registerFeedbackRoutes(app);
  return app;
}

// ── Sin sesión ───────────────────────────────────────────────────────────

test("GET /feedback sin sesión responde lista vacía, no error", async () => {
  const app = buildApp();
  const res = await app.request("/feedback?project=general");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [] });
});

test("POST /feedback sin sesión responde 401", async () => {
  const app = buildApp();
  const res = await app.request("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "T", description: "D" }),
  });
  assert.equal(res.status, 401);
});

test("PATCH /feedback/:id sin sesión responde 401", async () => {
  const app = buildApp();
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completado" }),
  });
  assert.equal(res.status, 401);
});

test("DELETE /feedback/:id sin sesión responde 401", async () => {
  const app = buildApp();
  const res = await app.request("/feedback/f1", { method: "DELETE" });
  assert.equal(res.status, 401);
});

// ── Validación de body ───────────────────────────────────────────────────

test("POST /feedback sin título responde 400", async () => {
  const app = buildApp({ userId: "u1" });
  const res = await app.request("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "D" }),
  });
  assert.equal(res.status, 400);
});

test("POST /feedback sin descripción responde 400", async () => {
  const app = buildApp({ userId: "u1" });
  const res = await app.request("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "T" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH /feedback/:id con status inválido responde 400", async () => {
  const app = buildApp({ userId: "u1" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "archivado" }),
  });
  assert.equal(res.status, 400);
});

// ── Puerta de "solo samu7montoya@gmail.com completa" ───────────────────────

test("PATCH a status=completado con OTRO correo responde 403 (no llega a tocar Supabase)", async () => {
  const app = buildApp({ userId: "u1", userEmail: "otro@gmail.com" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completado" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH a status=completado SIN correo en contexto (API key estática) responde 403", async () => {
  const app = buildApp({ userId: "u1" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completado" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH a status=en_revision con cualquier correo NO exige samu7montoya@gmail.com", async () => {
  const app = buildApp({ userId: "u1", userEmail: "otro@gmail.com" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "en_revision" }),
  });
  // No debe ser 403 — la puerta de correo es SOLO para "completado". Sin
  // Supabase configurado en este entorno de test, updateFeedbackStatus()
  // termina lanzando y la ruta responde 500 (no 403, que es lo que se
  // verifica acá: la puerta no se activó de más).
  assert.notEqual(res.status, 403);
});

test("PATCH a status=completado CON samu7montoya@gmail.com pasa la puerta (no 403)", async () => {
  const app = buildApp({ userId: "u1", userEmail: "samu7montoya@gmail.com" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completado" }),
  });
  assert.notEqual(res.status, 403);
});

test("PATCH compara el correo sin distinguir mayúsculas", async () => {
  const app = buildApp({ userId: "u1", userEmail: "SAMU7Montoya@Gmail.com" });
  const res = await app.request("/feedback/f1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completado" }),
  });
  assert.notEqual(res.status, 403);
});
