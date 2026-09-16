/**
 * Contrato HTTP de `/chat/threads*` sin sesión (LAN sin login / Supabase no
 * configurado) — mismo espíritu que chat.documents.test.ts: sin costura de
 * inyección a nivel de ruta, así que solo se prueban los caminos que NO
 * tocan Supabase real (todos los de "sin userId" son no-op por diseño, ver
 * el comentario de cabecera de chat-threads.ts). La lógica de negocio de la
 * papelera (soft delete/restore/purga con datos de verdad) vive en
 * ../chat-threads.test.ts, con un doble de Supabase inyectado.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerChatThreadsRoutes } from "./chat-threads.js";

function buildApp(): Hono {
  const app = new Hono();
  registerChatThreadsRoutes(app);
  return app;
}

test("GET /chat/threads sin sesión responde lista vacía, no error", async () => {
  const app = buildApp();
  const res = await app.request("/chat/threads");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { threads: unknown[]; activeId: string | null };
  assert.deepEqual(body, { threads: [], activeId: null });
});

test("GET /chat/threads?status=trashed sin sesión también responde vacío, no error", async () => {
  const app = buildApp();
  const res = await app.request("/chat/threads?status=trashed");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { threads: unknown[]; activeId: string | null };
  assert.deepEqual(body, { threads: [], activeId: null });
});

test("DELETE /chat/threads/:id sin sesión responde ok:true (fire-and-forget, no revienta el cliente)", async () => {
  const app = buildApp();
  const res = await app.request("/chat/threads/abc", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /chat/threads/:id/restore sin sesión responde ok:false (a diferencia del delete, restaurar SÍ debe poder fallar visiblemente)", async () => {
  const app = buildApp();
  const res = await app.request("/chat/threads/abc/restore", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false });
});

test("GET /chat/threads/:id sin sesión responde 404", async () => {
  const app = buildApp();
  const res = await app.request("/chat/threads/abc");
  assert.equal(res.status, 404);
});

test("PUT /chat/active sin sesión responde ok:false antes de validar el body (no-op, no error)", async () => {
  const app = buildApp();
  const res = await app.request("/chat/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "general" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false });
});
