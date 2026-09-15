/**
 * Tests HTTP de `POST /chat/documents` y `GET /chat/documents/status` —
 * el contrato de red del pipeline asíncrono (ver chat-document-jobs.ts).
 *
 * Se queda SOLO en los caminos de validación (sin archivos, archivo vacío,
 * demasiado grande, demasiados archivos) y en el contrato de `/status`: son
 * los únicos que no disparan `startChatDocumentJobs` de verdad, que en este
 * proceso usaría el Supabase/Ollama REALES de `.env` (no hay costura de
 * inyección de dependencias a nivel de ruta, igual que antes de este cambio
 * — la lógica de negocio inyectable vive en chat-document-jobs.test.ts). Un
 * archivo válido de más SÍ dispararía trabajo real en background: por eso no
 * se prueba acá.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerChatRoutes } from "./chat.js";

function buildApp(): Hono {
  const app = new Hono();
  registerChatRoutes(app);
  return app;
}

function formWithFiles(files: { name: string; content: string; type?: string }[]): FormData {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new File([f.content], f.name, { type: f.type ?? "text/plain" }));
  }
  return form;
}

test("POST /chat/documents sin campo 'files' responde 400", async () => {
  const app = buildApp();
  const res = await app.request("/chat/documents", { method: "POST", body: new FormData() });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /files.*requerido/);
});

test("POST /chat/documents con un archivo vacío responde 400 y no llega a encolar", async () => {
  const app = buildApp();
  const form = formWithFiles([{ name: "vacio.txt", content: "" }]);
  const res = await app.request("/chat/documents", { method: "POST", body: form });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /llegó vacío/);
});

test("POST /chat/documents con más archivos que MAX_DOCUMENTS_PER_UPLOAD responde 400", async () => {
  const app = buildApp();
  const files = Array.from({ length: 41 }, (_, i) => ({ name: `d${i}.txt`, content: "x" }));
  const form = formWithFiles(files);
  const res = await app.request("/chat/documents", { method: "POST", body: form });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /máximo 40 archivos/);
});

test("GET /chat/documents/status sin 'ids' responde 400", async () => {
  const app = buildApp();
  const res = await app.request("/chat/documents/status");
  assert.equal(res.status, 400);
});

test("GET /chat/documents/status con id desconocido responde 200 con status 'not_found', no revienta", async () => {
  const app = buildApp();
  const res = await app.request(
    "/chat/documents/status?ids=00000000-0000-0000-0000-000000000000",
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jobs: { docId: string; status: string }[] };
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].status, "not_found");
});

test("GET /chat/documents/status acepta varios ids separados por coma", async () => {
  const app = buildApp();
  const res = await app.request(
    "/chat/documents/status?ids=00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111",
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jobs: { docId: string; status: string }[] };
  assert.equal(body.jobs.length, 2);
  assert.ok(body.jobs.every((j) => j.status === "not_found"));
});
