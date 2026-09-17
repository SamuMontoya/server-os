/**
 * Tests de `ingestUploadedDocuments` — el orquestador de "el clip junto al
 * mic" (extraer texto, trocear, vectorizar, guardar en chat_docs).
 *
 * Corre con dependencias inyectadas (extractText/embedBatch/insertRows/
 * isReady), igual que `createTurnEngine` en chat-turns.test.ts: nada de red,
 * Ollama/OpenAI ni Supabase reales.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ingestUploadedDocuments,
  ingestOne,
  MAX_CHUNKS_PER_DOCUMENT,
  INGEST_CONCURRENCY,
  type UploadedFile,
  type IngestDeps,
  type ChatDocRow,
} from "./chat-documents.js";

const file = (name: string, text = "contenido de prueba", mimeType = "text/plain"): UploadedFile => ({
  name,
  mimeType,
  buffer: Buffer.from(text, "utf8"),
});

/** Deps felices por default; cada test pisa solo lo que necesita. */
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

// ── Happy path ──────────────────────────────────────────────────────────

test("happy path: un archivo con texto se extrae, trocea, vectoriza y guarda", async () => {
  const { deps, saved } = depsWith();
  const result = await ingestUploadedDocuments([file("notas.txt", "hola mundo")], deps);

  assert.equal(result.failed.length, 0);
  assert.equal(result.ok.length, 1);
  const doc = result.ok[0];
  assert.equal(doc.name, "notas.txt");
  assert.equal(doc.chunks, 1);
  assert.equal(doc.chars, "hola mundo".length);
  assert.equal(doc.truncated, false);
  assert.ok(doc.docId);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, "hola mundo");
  assert.equal(saved[0].chunk_index, 0);
  assert.equal(saved[0].chunk_count, 1);
});

test("happy path: varios archivos válidos en una sola tanda quedan todos en ok[]", async () => {
  const { deps } = depsWith();
  const result = await ingestUploadedDocuments(
    [file("a.txt", "texto a"), file("b.md", "texto b"), file("c.csv", "texto c")],
    deps,
  );
  assert.equal(result.ok.length, 3);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.ok.map((d) => d.name).sort(),
    ["a.txt", "b.md", "c.csv"].sort(),
  );
});

test("happy path: archivo grande se parte en varios fragmentos con solape", async () => {
  const { deps, saved } = depsWith({
    extractText: async () => "x".repeat(12_500), // ~3 chunks de 6000 con overlap 300
  });
  const result = await ingestUploadedDocuments([file("grande.txt")], deps);
  assert.equal(result.failed.length, 0);
  assert.ok(result.ok[0].chunks > 1);
  assert.equal(saved.length, result.ok[0].chunks);
  // chunk_count consistente en todas las filas del mismo doc.
  for (const row of saved) assert.equal(row.chunk_count, result.ok[0].chunks);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test("edge: Supabase no configurado falla TODOS los archivos sin gastar extracción", async () => {
  let extractCalled = false;
  const { deps } = depsWith({
    isReady: () => false,
    extractText: async () => {
      extractCalled = true;
      return "no debería llegar acá";
    },
  });
  const result = await ingestUploadedDocuments([file("a.txt"), file("b.txt")], deps);
  assert.equal(result.ok.length, 0);
  assert.equal(result.failed.length, 2);
  for (const f of result.failed) assert.equal(f.error, "Supabase no configurado");
  assert.equal(extractCalled, false);
});

test("edge: extractText lanza (PDF corrupto) → falla ese archivo, sigue con los demás", async () => {
  const { deps } = depsWith({
    extractText: async (_buf, _mime, name) => {
      if (name === "roto.pdf") throw new Error("PDF inválido");
      return "texto ok";
    },
  });
  const result = await ingestUploadedDocuments([file("roto.pdf"), file("bueno.txt")], deps);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "roto.pdf");
  assert.equal(result.failed[0].error, "PDF inválido");
  assert.equal(result.ok.length, 1);
  assert.equal(result.ok[0].name, "bueno.txt");
});

test("edge: sin texto extraíble (escaneado/formato no soportado) → falla con mensaje claro", async () => {
  const { deps } = depsWith({ extractText: async () => "" });
  const result = await ingestUploadedDocuments([file("escaneado.pdf")], deps);
  assert.equal(result.ok.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /sin texto extraíble/);
});

test("edge: texto que es solo espacios/control chars tras sanitizar cuenta como vacío", async () => {
  const { deps } = depsWith({ extractText: async () => "   \n\t  " });
  const result = await ingestUploadedDocuments([file("vacio.txt")], deps);
  assert.equal(result.ok.length, 0);
  assert.match(result.failed[0].error, /sin texto extraíble/);
});

test("edge (BUG FIX): embedding falla para algún fragmento → el archivo se marca failed, no se guarda con embedding null", async () => {
  const { deps, saved } = depsWith({
    // Simula lo que hace embeddings.ts de verdad: null por posición, no throw.
    embedBatch: async (texts) => texts.map((_, i) => (i === 0 ? null : [0.1, 0.2])),
    extractText: async () => "x".repeat(12_500), // fuerza >1 fragmento
  });
  const result = await ingestUploadedDocuments([file("importante.pdf")], deps);
  assert.equal(result.ok.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /vectorizar/);
  // Nada se insertó: ni siquiera los fragmentos cuyo embedding sí sirvió.
  assert.equal(saved.length, 0);
});

test("edge (BUG FIX): TODOS los embeddings null (motor caído) → failed, no ok mentiroso", async () => {
  const { deps, saved } = depsWith({ embedBatch: async (texts) => texts.map(() => null) });
  const result = await ingestUploadedDocuments([file("doc.txt", "algo de texto")], deps);
  assert.equal(result.ok.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(saved.length, 0);
});

test("edge: insertRows devuelve error de Supabase → falla ese archivo con el mensaje incluido", async () => {
  const { deps } = depsWith({ insertRows: async () => "duplicate key value" });
  const result = await ingestUploadedDocuments([file("a.txt")], deps);
  assert.equal(result.ok.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /no se pudo guardar/);
  assert.match(result.failed[0].error, /duplicate key value/);
});

test("edge: el presupuesto de fragmentos es POR DOCUMENTO y lo que no entra se marca truncado", async () => {
  const chunkSize = 6_000;
  const bigText = "z".repeat(chunkSize * (MAX_CHUNKS_PER_DOCUMENT + 5)); // De sobra para agotar el cupo
  const { deps } = depsWith({ extractText: async () => bigText });
  const result = await ingestUploadedDocuments([file("unico-gigante.txt")], deps);
  assert.equal(result.failed.length, 0);
  assert.equal(result.ok[0].chunks, MAX_CHUNKS_PER_DOCUMENT);
  assert.equal(result.ok[0].truncated, true);
});

test("edge: el presupuesto de fragmentos NO se comparte entre archivos — cada uno tiene el suyo (2026-09-15, antes uno gigante le quitaba cupo a los demás)", async () => {
  const chunkSize = 6_000;
  const bigText = "z".repeat(chunkSize * (MAX_CHUNKS_PER_DOCUMENT + 5));
  const { deps } = depsWith({
    extractText: async (_buf, _mime, name) => (name === "primero.txt" ? bigText : "poco texto"),
  });
  const result = await ingestUploadedDocuments([file("primero.txt"), file("segundo.txt")], deps);
  assert.equal(result.failed.length, 0);
  const primero = result.ok.find((r) => r.name === "primero.txt")!;
  const segundo = result.ok.find((r) => r.name === "segundo.txt")!;
  assert.equal(primero.chunks, MAX_CHUNKS_PER_DOCUMENT);
  assert.equal(primero.truncated, true);
  assert.equal(segundo.chunks, 1);
  assert.equal(segundo.truncated, false);
});

test("edge: archivos con el mismo nombre en la misma tanda no se pisan entre sí (doc_id distinto)", async () => {
  const { deps, saved } = depsWith();
  const result = await ingestUploadedDocuments(
    [file("reporte.pdf", "contenido A"), file("reporte.pdf", "contenido B")],
    deps,
  );
  assert.equal(result.ok.length, 2);
  const [first, second] = result.ok;
  assert.notEqual(first.docId, second.docId);
  const docIds = new Set(saved.map((r) => r.doc_id));
  assert.equal(docIds.size, 2);
});

test("edge: tanda vacía no falla, devuelve ok/failed vacíos", async () => {
  const { deps } = depsWith();
  const result = await ingestUploadedDocuments([], deps);
  assert.deepEqual(result, { ok: [], failed: [] });
});

test("edge: mezcla de éxito y fallo en la misma tanda no contamina el resultado del otro", async () => {
  const { deps } = depsWith({
    extractText: async (_buf, _mime, name) => (name === "malo.pdf" ? "" : "texto bueno"),
  });
  const result = await ingestUploadedDocuments([file("malo.pdf"), file("bueno.txt")], deps);
  assert.equal(result.ok.length, 1);
  assert.equal(result.ok[0].name, "bueno.txt");
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "malo.pdf");
});

test("edge: nunca hay más de INGEST_CONCURRENCY extracciones en vuelo a la vez (2026-09-15: antes era 100% serial)", async () => {
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
  const files = Array.from({ length: INGEST_CONCURRENCY * 3 }, (_, i) => file(`doc-${i}.txt`));
  const result = await ingestUploadedDocuments(files, deps);
  assert.equal(result.ok.length, files.length);
  // Sube por encima de 1 (hay paralelismo real)...
  assert.ok(picoMaximo > 1, `esperaba paralelismo > 1, midió ${picoMaximo}`);
  // ...pero nunca más allá del tope fijado.
  assert.ok(picoMaximo <= INGEST_CONCURRENCY, `esperaba <= ${INGEST_CONCURRENCY}, midió ${picoMaximo}`);
});

test("edge: con un solo archivo no hace falta paralelismo, sigue funcionando igual", async () => {
  const { deps } = depsWith();
  const result = await ingestUploadedDocuments([file("solo.txt")], deps);
  assert.equal(result.ok.length, 1);
  assert.equal(result.failed.length, 0);
});

// ── Progreso (`onProgress` de `ingestOne`, auditoría 2026-09-17) ───────

test("ingestOne llama onProgress(0, total) apenas trocea, ANTES de vectorizar nada", async () => {
  const calls: [number, number][] = [];
  const { deps } = depsWith({
    extractText: async () => "x".repeat(12_500), // varios chunks
    embedBatch: async (texts, onEmbedProgress) => {
      // Si onProgress(0, total) no se llamó todavía en este punto, el
      // contrato "se conoce el total antes de vectorizar" está roto.
      assert.deepEqual(calls[0], [0, texts.length]);
      onEmbedProgress?.(texts.length, texts.length);
      return texts.map(() => [0.1]);
    },
  });
  const result = await ingestOne(
    file("grande.txt"),
    deps as Required<Pick<IngestDeps, "extractText" | "embedBatch" | "insertRows">>,
    "doc-1",
    (done, total) => calls.push([done, total]),
  );
  assert.ok("ok" in result);
  // Última llamada: todo hecho.
  const [lastDone, lastTotal] = calls[calls.length - 1];
  assert.equal(lastDone, lastTotal);
});

test("ingestOne propaga cada lote de embedBatch como un avance de progreso intermedio", async () => {
  const calls: [number, number][] = [];
  const { deps } = depsWith({
    extractText: async () => "x".repeat(25_000), // ~5 chunks
    embedBatch: async (texts, onEmbedProgress) => {
      // Simula 2 lotes internos (mismo patrón que viaOllama con BATCH=8).
      const mid = Math.ceil(texts.length / 2);
      onEmbedProgress?.(mid, texts.length);
      onEmbedProgress?.(texts.length, texts.length);
      return texts.map(() => [0.1]);
    },
  });
  await ingestOne(
    file("grande.txt"),
    deps as Required<Pick<IngestDeps, "extractText" | "embedBatch" | "insertRows">>,
    "doc-2",
    (done, total) => calls.push([done, total]),
  );
  // 0/N inicial (chunking) + 2 avances intermedios de embedBatch, en orden creciente.
  assert.ok(calls.length >= 3, `esperaba al menos 3 avances, hubo ${calls.length}`);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i][0] >= calls[i - 1][0]);
});

test("ingestOne sin onProgress sigue funcionando igual (parámetro opcional real, no solo de tipos)", async () => {
  const { deps } = depsWith();
  const result = await ingestOne(
    file("solo.txt", "hola"),
    deps as Required<Pick<IngestDeps, "extractText" | "embedBatch" | "insertRows">>,
  );
  assert.ok("ok" in result);
});
