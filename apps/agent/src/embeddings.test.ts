/**
 * Tests del motor de embeddings — específicamente lo que se agregó en la
 * auditoría 2026-09-17 ("la subida de documentos sigue lenta"): el mutex que
 * serializa las llamadas reales a Ollama (`-np 1`, un solo slot de cómputo
 * en este VPS), el timeout por request (para que un Ollama "vivo pero
 * mudo" no cuelgue un job para siempre) y el progreso/EMA que alimenta el
 * ETA que muestra el composer.
 *
 * Corre con `EMBEDDINGS_PROVIDER=ollama` real (viene del `.env` del repo,
 * cargado por env.ts) — lo que se mockea es `globalThis.fetch`, nunca un
 * Ollama de verdad ni Supabase.
 *
 *   pnpm --filter @hermes/agent test
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { embedBatch, avgOllamaChunkMs, PROVIDER } from "./embeddings.js";

// Todo este archivo asume que corre contra el proveedor ollama (igual que
// producción) — si algún día el `.env` de test cambia de proveedor, mejor
// fallar alto y claro que dar falsos verdes silenciosos.
test.before(() => {
  assert.equal(PROVIDER, "ollama", "estos tests asumen EMBEDDINGS_PROVIDER=ollama (ver .env del repo)");
});

function fakeEmbedResponse(input: string[]): Response {
  return {
    ok: true,
    json: async () => ({ embeddings: input.map(() => Array(768).fill(0.01)) }),
    text: async () => "",
  } as Response;
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("mutex: dos embedBatch 'en paralelo' (dos jobs distintos) nunca tienen más de 1 fetch real en vuelo", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withFetch(
    (async (_url: string, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      const input = (JSON.parse(init!.body as string) as { input: string[] }).input;
      inFlight--;
      return fakeEmbedResponse(input);
    }) as typeof fetch,
    async () => {
      const [r1, r2] = await Promise.all([embedBatch(["a", "b"]), embedBatch(["c", "d"])]);
      assert.equal(r1.length, 2);
      assert.equal(r2.length, 2);
      assert.ok(r1.every((v) => v !== null));
      assert.ok(r2.every((v) => v !== null));
    },
  );
  assert.equal(maxInFlight, 1, `esperaba que el mutex serializara (máx 1 en vuelo), midió ${maxInFlight}`);
});

test("mutex: una request que revienta en TODOS sus reintentos no rompe el mutex para las siguientes", async () => {
  let call = 0;
  await withFetch(
    (async (_url: string, init?: RequestInit) => {
      call++;
      const input = (JSON.parse(init!.body as string) as { input: string[] }).input;
      // `fetchOllamaBatch` reintenta una vez sola (MAX_OLLAMA_ATTEMPTS=2, fix
      // 2026-09-19: un solo hipo transitorio no puede reprobar el documento
      // entero) — para probar que el mutex sobrevive a un fallo real hay que
      // agotar AMBOS intentos del primer `embedBatch`, no solo el primero.
      if (call <= 2) throw new Error("boom de red simulado");
      return fakeEmbedResponse(input);
    }) as typeof fetch,
    async () => {
      const r1 = await embedBatch(["falla"]);
      assert.deepEqual(r1, [null]); // agotó los 2 intentos; el propio embedBatch nunca lanza
      const r2 = await embedBatch(["deberia-funcionar"]);
      assert.ok(r2[0] !== null, "el mutex debe seguir vivo tras agotar los reintentos del anterior");
    },
  );
});

test("onProgress arranca en (0,total) y crece con cada lote real que Ollama devuelve", async () => {
  await withFetch(
    (async (_url: string, init?: RequestInit) => {
      const input = (JSON.parse(init!.body as string) as { input: string[] }).input;
      return fakeEmbedResponse(input);
    }) as typeof fetch,
    async () => {
      const calls: [number, number][] = [];
      const texts = Array.from({ length: 10 }, (_, i) => `texto ${i}`); // BATCH=8 interno ⇒ 2 lotes (8 + 2)
      const out = await embedBatch(texts, (done, total) => calls.push([done, total]));
      assert.equal(out.length, 10);
      assert.deepEqual(calls[0], [0, 10]);
      assert.deepEqual(calls[calls.length - 1], [10, 10]);
      assert.ok(calls.length >= 3, `esperaba al menos 3 avances (inicial + 2 lotes), hubo ${calls.length}`);
      for (let i = 1; i < calls.length; i++) {
        assert.ok(calls[i][0] >= calls[i - 1][0], "el progreso nunca debería retroceder");
      }
    },
  );
});

test("avgOllamaChunkMs se recalibra (EMA) con la duración real medida de una request exitosa", async () => {
  const before = avgOllamaChunkMs;
  await withFetch(
    (async (_url: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 5));
      const input = (JSON.parse(init!.body as string) as { input: string[] }).input;
      return fakeEmbedResponse(input);
    }) as typeof fetch,
    async () => {
      await embedBatch(["uno"]);
    },
  );
  assert.notEqual(avgOllamaChunkMs, before, "esperaba que la EMA se moviera tras una medición real");
});

test("timeout: un fetch que nunca responde no cuelga el batch para siempre — se aborta, reintenta una vez y al final vuelve null", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await withFetch(
      (((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as unknown) as typeof fetch,
      async () => {
        const promise = embedBatch(["texto que nunca vuelve"]);
        // `fetchOllamaBatch` reintenta una vez (MAX_OLLAMA_ATTEMPTS=2, fix
        // 2026-09-19) — cada intento registra su PROPIO `setTimeout`, así que
        // hay que repetir el mismo baile dos veces: `withOllamaLock` encadena
        // la primera llamada con un `.then()` (microtask), así que
        // `fetchOllamaBatch` recién registra su `setTimeout` real un turno
        // después de esta línea — hay que dejar correr ESE turno (macrotask
        // real, `setImmediate` no está mockeado) antes de adelantar el reloj
        // falso, o `tick()` no encuentra ningún timer todavía y no dispara
        // nada. El reintento (llamada recursiva DENTRO de la misma cadena de
        // promesas) repite el mismo patrón.
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise((r) => setImmediate(r));
          // Timeout real = 20_000 + 15_000*1 = 35_000ms por intento.
          mock.timers.tick(35_001);
        }
        const result = await promise;
        assert.deepEqual(result, [null]);
      },
    );
  } finally {
    mock.timers.reset();
  }
});

test("dimensión inesperada del vector (Ollama devolvió otro modelo/config): se descarta como null, no revienta", async () => {
  await withFetch(
    (async () => {
      return {
        ok: true,
        json: async () => ({ embeddings: [Array(42).fill(0.01)] }), // 42 ≠ 768 esperado
        text: async () => "",
      } as Response;
    }) as typeof fetch,
    async () => {
      const out = await embedBatch(["texto"]);
      assert.deepEqual(out, [null]);
    },
  );
});
