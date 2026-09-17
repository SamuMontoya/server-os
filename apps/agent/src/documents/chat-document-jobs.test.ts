/**
 * Tests de `startChatDocumentJobs`/`getDocJobs` — el motor asíncrono que
 * reemplazó a `ingestUploadedDocuments` corriendo DENTRO del request HTTP
 * (auditoría 2026-09-15: un PDF de 2MB bloqueaba `POST /chat/documents` casi
 * 200s en este VPS de 1 vCPU). Mismo espíritu que chat-documents.test.ts:
 * deps inyectadas, nada de red/Ollama/Supabase reales.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  startChatDocumentJobs,
  getDocJobs,
  _resetDocJobsForTests,
  type DocJob,
} from "./chat-document-jobs.js";
import type { UploadedFile, IngestDeps, ChatDocRow } from "./chat-documents.js";

const file = (name: string, text = "contenido de prueba", mimeType = "text/plain"): UploadedFile => ({
  name,
  mimeType,
  buffer: Buffer.from(text, "utf8"),
});

function depsWith(overrides: Partial<IngestDeps> = {}): { deps: Partial<IngestDeps>; saved: ChatDocRow[] } {
  const saved: ChatDocRow[] = [];
  const deps: Partial<IngestDeps> = {
    isReady: () => true,
    extractText: async (buf) => buf.toString("utf8"),
    embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    insertRows: async (rows) => {
      saved.push(...rows);
      return null;
    },
    ...overrides,
  };
  return { deps, saved };
}

/** Espera hasta que TODOS los ids salgan de "processing", o revienta por timeout. */
async function waitSettled(ids: string[], timeoutMs = 2000): Promise<DocJob[]> {
  const start = Date.now();
  for (;;) {
    const jobs = getDocJobs(ids);
    if (jobs.every((j) => j.status !== "processing")) return jobs as DocJob[];
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout esperando que ${ids.length} job(s) salieran de "processing"`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

test.beforeEach(() => _resetDocJobsForTests());

// ── Contrato de "devuelve YA, procesa después" ─────────────────────────

test("startChatDocumentJobs devuelve de inmediato en 'processing', sin esperar el vectorizado", () => {
  let embedResolved = false;
  const { deps } = depsWith({
    embedBatch: async (texts) => {
      // Nunca resuelve dentro de este test: si `startChatDocumentJobs`
      // esperara esta promesa, el assert de abajo jamás se alcanzaría.
      await new Promise(() => {});
      embedResolved = true;
      return texts.map(() => [0.1]);
    },
  });
  const queued = startChatDocumentJobs([file("a.txt")], deps);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "processing");
  assert.ok(queued[0].docId);
  assert.equal(embedResolved, false); // la función ya volvió sin tocar embed
});

test("happy path: el job pasa de 'processing' a 'ready' con chunks/chars una vez termina en background", async () => {
  const { deps } = depsWith();
  const [queued] = startChatDocumentJobs([file("notas.txt", "hola mundo")], deps);
  const [job] = await waitSettled([queued.docId]);
  assert.equal(job.status, "ready");
  assert.equal(job.name, "notas.txt");
  assert.equal(job.chunks, 1);
  assert.equal(job.chars, "hola mundo".length);
  assert.equal(job.truncated, false);
});

test("archivo que falla (sin texto extraíble) llega a 'error' con mensaje, no se queda colgado", async () => {
  const { deps } = depsWith({ extractText: async () => "" });
  const [queued] = startChatDocumentJobs([file("escaneado.pdf")], deps);
  const [job] = await waitSettled([queued.docId]);
  assert.equal(job.status, "error");
  assert.match(job.error ?? "", /sin texto extraíble/);
});

test("varios archivos en la misma tanda: cada uno resuelve su propio job de forma independiente", async () => {
  const { deps } = depsWith({
    extractText: async (_buf, _mime, name) => (name === "malo.pdf" ? "" : "texto ok"),
  });
  const queued = startChatDocumentJobs([file("malo.pdf"), file("bueno.txt")], deps);
  assert.equal(queued.length, 2);
  const jobs = await waitSettled(queued.map((q) => q.docId));
  const malo = jobs.find((j) => j.name === "malo.pdf")!;
  const bueno = jobs.find((j) => j.name === "bueno.txt")!;
  assert.equal(malo.status, "error");
  assert.equal(bueno.status, "ready");
});

test("Supabase no configurado: el job queda 'error' inmediatamente, sin gastar extracción", async () => {
  let extractCalled = false;
  const { deps } = depsWith({
    isReady: () => false,
    extractText: async () => {
      extractCalled = true;
      return "no debería llegar";
    },
  });
  const [queued] = startChatDocumentJobs([file("a.txt")], deps);
  // Ya sale en error desde `startChatDocumentJobs` mismo (no hace falta polling).
  assert.equal(queued.status, "processing"); // el contrato de QueuedDoc es siempre "processing"...
  const [job] = getDocJobs([queued.docId]);
  assert.equal(job.status, "error"); // ...pero el registro interno ya refleja el error real.
  assert.equal((job as DocJob).error, "Supabase no configurado");
  assert.equal(extractCalled, false);
});

// ── getDocJobs: ids desconocidos no rompen la respuesta ────────────────

test("getDocJobs con un id inexistente devuelve 'not_found' para ese id, sin tocar los demás", async () => {
  const { deps } = depsWith();
  const [queued] = startChatDocumentJobs([file("a.txt")], deps);
  await waitSettled([queued.docId]);
  const jobs = getDocJobs([queued.docId, "00000000-0000-0000-0000-000000000000"]);
  assert.equal(jobs[0].status, "ready");
  assert.equal(jobs[1].status, "not_found");
});

test("getDocJobs con lista vacía no revienta", () => {
  assert.deepEqual(getDocJobs([]), []);
});

// ── Concurrencia acotada también en el modo async ──────────────────────

test("el pipeline async respeta la misma concurrencia acotada que la versión síncrona", async () => {
  let enVuelo = 0;
  let picoMaximo = 0;
  const { deps } = depsWith({
    extractText: async () => {
      enVuelo++;
      picoMaximo = Math.max(picoMaximo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo--;
      return "algo de texto";
    },
  });
  const files = Array.from({ length: 6 }, (_, i) => file(`doc-${i}.txt`));
  const queued = startChatDocumentJobs(files, deps);
  await waitSettled(queued.map((q) => q.docId));
  assert.ok(picoMaximo > 1, `esperaba paralelismo > 1, midió ${picoMaximo}`);
  assert.ok(picoMaximo <= 2, `esperaba <= INGEST_CONCURRENCY (2), midió ${picoMaximo}`);
});

// ── Progreso/ETA (auditoría 2026-09-17: "la subida es lenta") ─────────

test("mientras procesa, el job expone chunksDone/chunksTotal crecientes vía getDocJobs", async () => {
  let releaseEmbed: (() => void) | undefined;
  const gate = new Promise<void>((r) => (releaseEmbed = r));
  const { deps } = depsWith({
    extractText: async () => "x".repeat(25_000), // varios chunks
    embedBatch: async (texts, onProgress) => {
      const mid = Math.ceil(texts.length / 2);
      onProgress?.(mid, texts.length);
      await gate; // se congela a mitad de camino hasta que el test lo suelte
      onProgress?.(texts.length, texts.length);
      return texts.map(() => [0.1]);
    },
  });
  const [queued] = startChatDocumentJobs([file("grande.txt")], deps);
  // Poll manual hasta ver progreso intermedio > 0 (sin esperar a "ready").
  const start = Date.now();
  let mid: ReturnType<typeof getDocJobs>[number] | undefined;
  while (Date.now() - start < 2000) {
    const [j] = getDocJobs([queued.docId]);
    if ("chunksDone" in j && (j.chunksDone ?? 0) > 0) {
      mid = j;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(mid, "nunca se vio progreso intermedio antes del timeout");
  assert.ok((mid as DocJob).chunksTotal! > 0);
  assert.ok((mid as DocJob).chunksDone! < (mid as DocJob).chunksTotal!, "a mitad de camino, no debería estar completo");
  releaseEmbed?.();
  const [done] = await waitSettled([queued.docId]);
  assert.equal(done.status, "ready");
});

test("getDocJobs no calcula etaMs para un job que ya está 'ready' (solo tiene sentido en 'processing')", async () => {
  const { deps } = depsWith();
  const [queued] = startChatDocumentJobs([file("chico.txt", "hola")], deps);
  await waitSettled([queued.docId]);
  const [job] = getDocJobs([queued.docId]);
  assert.equal(job.status, "ready");
  assert.equal((job as { etaMs?: number }).etaMs, undefined);
});

test("getDocJobs no revienta ni inventa etaMs si un job 'processing' todavía no tiene chunksTotal (recién arrancó)", () => {
  const { deps } = depsWith({
    embedBatch: async () => {
      await new Promise(() => {}); // nunca resuelve: se queda "processing" sin progreso reportado
      return [];
    },
  });
  const [queued] = startChatDocumentJobs([file("a.txt")], deps);
  const [job] = getDocJobs([queued.docId]);
  assert.equal(job.status, "processing");
  assert.equal((job as { etaMs?: number }).etaMs, undefined);
});
