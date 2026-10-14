/**
 * Mismo patrón que chat-threads.test.ts: `logTurnUsage`/`getUsageByEmail`
 * aceptan un `client` inyectable (por defecto el singleton real de
 * supabase.ts) — acá se les pasa un doble en memoria que imita el
 * subconjunto de la API fluida que este módulo realmente usa
 * (`.insert()`, `.select().gte()`), para poder probar la agregación sin
 * tocar una base real ni dejar filas de prueba en producción.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { logTurnUsage, getUsageByEmail, type UsageClient } from "./usage-log.js";

type Row = Record<string, unknown>;

/** Doble en memoria — solo lo que usage-log.ts de verdad usa. */
function fakeClient(seed: Row[] = []): { client: UsageClient; rows: () => Row[] } {
  const rows: Row[] = seed.map((r) => ({ ...r }));

  function from(_table: string) {
    let gteCol: string | null = null;
    let gteVal: string | null = null;

    const builder = {
      insert(payload: Row) {
        rows.push({ ...payload, id: `fake-${rows.length}`, created_at: new Date().toISOString() });
        return Promise.resolve({ error: null });
      },
      select(_cols: string) {
        return builder;
      },
      gte(col: string, val: string) {
        gteCol = col;
        gteVal = val;
        // Al final de la cadena, la "promesa" se resuelve con lo filtrado —
        // PostgREST-js real también deja a `select()` ser thenable; acá el
        // `then` vive en el objeto que gte() devuelve (mismo truco que la
        // query real: awaitable directamente, sin `.execute()` aparte).
        return Promise.resolve({
          data: rows.filter((r) => !gteCol || (r[gteCol] as string) >= (gteVal as string)),
          error: null,
        });
      },
      // `select()` sin `.gte()` encadenado (ventana "todo el historial"):
      // awaitable directo también.
      then(onFulfilled: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    };
    return builder;
  }

  return { client: { from } as unknown as UsageClient, rows: () => rows };
}

const USAGE_DE_PRUEBA = {
  entrada: 1000,
  salida: 200,
  cacheEscrito: 50,
  cacheLeido: 900,
  cacheado: 0.9,
  costoUsd: 0.0123,
};

test("logTurnUsage inserta una fila con los campos correctos (correo en minúsculas, recortado)", async () => {
  const { client, rows } = fakeClient();
  await logTurnUsage(
    { userEmail: "  Jaime@Example.com  ", project: "produccion", model: "claude-sonnet-5", usage: USAGE_DE_PRUEBA },
    client,
  );
  assert.equal(rows().length, 1);
  const row = rows()[0];
  assert.equal(row.user_email, "jaime@example.com");
  assert.equal(row.project, "produccion");
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.output_tokens, 200);
  assert.equal(row.cache_read_tokens, 900);
  assert.equal(row.cache_write_tokens, 50);
  assert.equal(row.cost_usd, 0.0123);
});

test("logTurnUsage sin userEmail (HERMES_API_KEY/reloj): inserta con user_email null, no revienta", async () => {
  const { client, rows } = fakeClient();
  await logTurnUsage({ model: "claude-haiku-4-5", usage: USAGE_DE_PRUEBA }, client);
  assert.equal(rows()[0].user_email, null);
});

test("logTurnUsage con costoUsd ausente cae a 0, no a null/undefined en la fila", async () => {
  const { client, rows } = fakeClient();
  await logTurnUsage(
    { model: "claude-haiku-4-5", usage: { entrada: 10, salida: 5, cacheEscrito: 0, cacheLeido: 0, cacheado: 0 } },
    client,
  );
  assert.equal(rows()[0].cost_usd, 0);
});

test("logTurnUsage sin cliente (null, Supabase no configurado): no rompe, no inserta nada", async () => {
  await assert.doesNotReject(
    logTurnUsage({ model: "claude-sonnet-5", usage: USAGE_DE_PRUEBA }, null),
  );
});

test("getUsageByEmail: agrega tokens/costo por correo, ordenado de mayor a menor costo", async () => {
  const { client } = fakeClient([
    { user_email: "jaime@example.com", input_tokens: 1000, output_tokens: 200, cost_usd: "0.05" },
    { user_email: "jaime@example.com", input_tokens: 500, output_tokens: 100, cost_usd: "0.02" },
    { user_email: "samu@example.com", input_tokens: 2000, output_tokens: 400, cost_usd: "0.20" },
  ]);
  const result = await getUsageByEmail(undefined, client);
  assert.equal(result.length, 2);
  // samu gastó más → primero.
  assert.equal(result[0].email, "samu@example.com");
  assert.equal(result[0].turns, 1);
  assert.equal(result[0].costUsd, 0.2);
  assert.equal(result[1].email, "jaime@example.com");
  assert.equal(result[1].turns, 2);
  assert.equal(result[1].totalTokens, 1000 + 200 + 500 + 100);
  // 0.05 + 0.02 con floats: verificar con tolerancia, no igualdad exacta.
  assert.ok(Math.abs(result[1].costUsd - 0.07) < 1e-9);
});

test("getUsageByEmail: filas sin user_email se agrupan bajo '(sin correo)'", async () => {
  const { client } = fakeClient([
    { user_email: null, input_tokens: 100, output_tokens: 10, cost_usd: "0.001" },
  ]);
  const result = await getUsageByEmail(undefined, client);
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "(sin correo)");
});

test("getUsageByEmail: sin ninguna fila, devuelve array vacío", async () => {
  const { client } = fakeClient([]);
  const result = await getUsageByEmail(undefined, client);
  assert.deepEqual(result, []);
});

test("getUsageByEmail: con createdAfter, filtra por fecha (gte)", async () => {
  const { client } = fakeClient([
    { user_email: "jaime@example.com", input_tokens: 100, output_tokens: 10, cost_usd: "0.01", created_at: "2026-01-01T00:00:00Z" },
    { user_email: "jaime@example.com", input_tokens: 200, output_tokens: 20, cost_usd: "0.02", created_at: "2026-10-01T00:00:00Z" },
  ]);
  const result = await getUsageByEmail(new Date("2026-06-01T00:00:00Z"), client);
  assert.equal(result.length, 1);
  assert.equal(result[0].inputTokens, 200);
});

test("getUsageByEmail sin cliente (null, Supabase no configurado): devuelve vacío sin romper", async () => {
  const result = await getUsageByEmail(undefined, null);
  assert.deepEqual(result, []);
});
