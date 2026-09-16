/**
 * Tests de la lógica de la papelera de chats (migración 032):
 * `deleteThread` (soft-delete), `restoreThread`, `purgeExpiredTrashedThreads`
 * y el filtro por `status` de `listThreadsMeta`.
 *
 * Todas las funciones de chat-threads.ts aceptan un `client` inyectable
 * (por defecto el singleton real de supabase.ts) — acá se les pasa un doble
 * en memoria que imita el subconjunto de la API fluida de PostgREST que este
 * módulo realmente usa (`.from().select().eq().order().limit()`,
 * `.update()...select()`, `.delete()...select()`), para poder probar los
 * filtros y los cortes de fecha sin una base real.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  listThreadsMeta,
  deleteThread,
  restoreThread,
  purgeExpiredTrashedThreads,
  TRASH_RETENTION_MS,
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  type ThreadsClient,
} from "./chat-threads.js";

type Row = Record<string, unknown>;

/** Doble en memoria de un cliente Supabase — solo lo que chat-threads.ts usa. */
function fakeClient(seed: Row[]): { client: ThreadsClient; rows: () => Row[] } {
  let rows = seed.map((r) => ({ ...r }));

  function from(_table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let action: "select" | "update" | "delete" = "select";
    let updatePayload: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let wantsSelect = false;
    let single = false;

    const api = {
      select() {
        wantsSelect = true;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      lt(col: string, val: unknown) {
        filters.push((r) => r[col] != null && (r[col] as string) < (val as string));
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderCol = col;
        orderAsc = opts.ascending;
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      maybeSingle() {
        single = true;
        return api;
      },
      update(payload: Row) {
        action = "update";
        updatePayload = payload;
        return api;
      },
      delete() {
        action = "delete";
        return api;
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (action === "update") {
          for (const r of matched) Object.assign(r, updatePayload);
          resolve({ data: wantsSelect ? matched.map((r) => ({ ...r })) : null, error: null });
          return;
        }
        if (action === "delete") {
          const doomed = new Set(matched);
          rows = rows.filter((r) => !doomed.has(r));
          resolve({ data: wantsSelect ? matched.map((r) => ({ ...r })) : null, error: null });
          return;
        }
        // select
        let out = matched;
        if (orderCol) {
          const col = orderCol;
          out = [...out].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return orderAsc ? cmp : -cmp;
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        resolve(single ? { data: out[0] ?? null, error: null } : { data: out.map((r) => ({ ...r })), error: null });
      },
    };
    return api;
  }

  return { client: { from } as unknown as ThreadsClient, rows: () => rows };
}

const iso = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

function row(overrides: Partial<Row> = {}, now = Date.now()): Row {
  return {
    id: "t1",
    user_id: "u1",
    project: "general",
    title: "Chat de prueba",
    updated_at: iso(0, now),
    model: null,
    sdk_session_id: null,
    pending_turn: null,
    session_key: "",
    messages: [],
    draft: "",
    status: "active",
    deleted_at: null,
    ...overrides,
  };
}

// ── listThreadsMeta: filtro por status ──────────────────────────────────

test("listThreadsMeta sin opts trae solo los activos, no los trashed", async () => {
  const { client } = fakeClient([
    row({ id: "a", status: "active" }),
    row({ id: "b", status: "trashed", deleted_at: iso(1000, Date.now()) }),
  ]);
  const out = await listThreadsMeta("u1", "general", {}, client);
  assert.deepEqual(out.map((t) => t.id), ["a"]);
  assert.equal(out[0].status, "active");
  assert.equal(out[0].deletedAt, null);
});

test("listThreadsMeta({status:'trashed'}) trae solo la papelera, ordenada por deleted_at desc", async () => {
  const now = Date.now();
  const { client } = fakeClient([
    row({ id: "old", status: "trashed", deleted_at: iso(5000, now) }),
    row({ id: "new", status: "trashed", deleted_at: iso(1000, now) }),
    row({ id: "active", status: "active" }),
  ]);
  const out = await listThreadsMeta("u1", "general", { status: "trashed" }, client);
  assert.deepEqual(out.map((t) => t.id), ["new", "old"]);
  assert.ok(out.every((t) => t.status === "trashed"));
});

test("listThreadsMeta scoped por user_id y project — no cruza datos de otro usuario/proyecto", async () => {
  const { client } = fakeClient([
    row({ id: "mine", user_id: "u1", project: "general" }),
    row({ id: "other-user", user_id: "u2", project: "general" }),
    row({ id: "other-project", user_id: "u1", project: "work" }),
  ]);
  const out = await listThreadsMeta("u1", "general", {}, client);
  assert.deepEqual(out.map((t) => t.id), ["mine"]);
});

test("listThreadsMeta sin client (Supabase no configurado) devuelve [] sin reventar", async () => {
  const out = await listThreadsMeta("u1", "general", {}, null);
  assert.deepEqual(out, []);
});

// ── deleteThread: soft delete ────────────────────────────────────────────

test("deleteThread NO borra la fila — la marca trashed con deleted_at reciente", async () => {
  const { client, rows } = fakeClient([row({ id: "a", status: "active" })]);
  const before = Date.now();
  await deleteThread("u1", "a", client);
  const [r] = rows();
  assert.equal(r.status, "trashed");
  assert.ok(r.deleted_at, "deleted_at debe quedar seteado");
  assert.ok(new Date(r.deleted_at as string).getTime() >= before);
});

test("deleteThread scoped por user_id — no trashea el chat de otro usuario aunque comparta id", async () => {
  const { client, rows } = fakeClient([row({ id: "shared", user_id: "u2", status: "active" })]);
  await deleteThread("u1", "shared", client);
  assert.equal(rows()[0].status, "active"); // no era suyo, no se tocó
});

test("deleteThread sin client no revienta (no-op)", async () => {
  await assert.doesNotReject(deleteThread("u1", "a", null));
});

// ── restoreThread ─────────────────────────────────────────────────────────

test("restoreThread saca un chat trashed de la papelera y devuelve ok:true", async () => {
  const { client, rows } = fakeClient([
    row({ id: "a", status: "trashed", deleted_at: iso(1000, Date.now()) }),
  ]);
  const ok = await restoreThread("u1", "a", client);
  assert.equal(ok, true);
  const [r] = rows();
  assert.equal(r.status, "active");
  assert.equal(r.deleted_at, null);
});

test("restoreThread sobre un chat que YA está activo no hace nada y devuelve false", async () => {
  const { client, rows } = fakeClient([row({ id: "a", status: "active" })]);
  const ok = await restoreThread("u1", "a", client);
  assert.equal(ok, false);
  assert.equal(rows()[0].status, "active");
});

test("restoreThread sobre un id inexistente (ya purgado) devuelve false sin reventar", async () => {
  const { client } = fakeClient([]);
  const ok = await restoreThread("u1", "no-existe", client);
  assert.equal(ok, false);
});

test("restoreThread sin client devuelve false", async () => {
  assert.equal(await restoreThread("u1", "a", null), false);
});

test("restoreThread scoped por user_id — no restaura el chat de otro usuario aunque comparta id y esté trashed", async () => {
  const { client, rows } = fakeClient([
    row({ id: "shared", user_id: "u2", status: "trashed", deleted_at: iso(1000, Date.now()) }),
  ]);
  const ok = await restoreThread("u1", "shared", client);
  assert.equal(ok, false);
  assert.equal(rows()[0].status, "trashed"); // no era suyo, no se tocó
});

// ── purgeExpiredTrashedThreads ────────────────────────────────────────────

test("purgeExpiredTrashedThreads borra lo trashed hace MÁS de 30 días y respeta lo más nuevo", async () => {
  const now = Date.now();
  const { client, rows } = fakeClient([
    row({ id: "vencido", status: "trashed", deleted_at: iso(TRASH_RETENTION_MS + 60_000, now) }),
    row({ id: "al-limite", status: "trashed", deleted_at: iso(TRASH_RETENTION_MS - 60_000, now) }),
    row({ id: "activo", status: "active" }),
  ]);
  const result = await purgeExpiredTrashedThreads(now, client);
  assert.equal(result?.purged, 1);
  const ids = rows().map((r) => r.id);
  assert.ok(!ids.includes("vencido"));
  assert.ok(ids.includes("al-limite"), "un trashed reciente no debe purgarse");
  assert.ok(ids.includes("activo"), "un chat activo nunca se purga");
});

test("purgeExpiredTrashedThreads sin nada vencido no borra ni rompe", async () => {
  const now = Date.now();
  const { client, rows } = fakeClient([row({ id: "reciente", status: "trashed", deleted_at: iso(1000, now) })]);
  const result = await purgeExpiredTrashedThreads(now, client);
  assert.equal(result?.purged, 0);
  assert.equal(rows().length, 1);
});

test("purgeExpiredTrashedThreads sin client (Supabase no configurado) devuelve null", async () => {
  assert.equal(await purgeExpiredTrashedThreads(Date.now(), null), null);
});

test("purgeExpiredTrashedThreads ignora un trashed con deleted_at null (dato inconsistente) en vez de reventar", async () => {
  // La migración 032 hace este estado imposible a nivel de DB (constraint
  // chat_threads_trash_consistency_check), pero el doble en memoria no lo
  // valida — sirve para probar que la query en sí (lt sobre null) no explota
  // y de paso confirma por qué el constraint hace falta: sin él, una fila así
  // quedaría en la papelera para siempre porque `deleted_at < cutoff` nunca
  // matchea un NULL.
  const { client, rows } = fakeClient([row({ id: "corrupto", status: "trashed", deleted_at: null })]);
  const result = await purgeExpiredTrashedThreads(Date.now(), client);
  assert.equal(result?.purged, 0);
  assert.equal(rows().length, 1, "no se borra ni se cae por un deleted_at null");
});

test("purgeExpiredTrashedThreads pagina en tandas: purga más de PURGE_BATCH_SIZE filas vencidas en una sola corrida", async () => {
  const now = Date.now();
  const total = PURGE_BATCH_SIZE + 5;
  const seed = Array.from({ length: total }, (_, i) =>
    row({ id: `t${i}`, status: "trashed", deleted_at: iso(TRASH_RETENTION_MS + 60_000, now) }, now),
  );
  const { client, rows } = fakeClient(seed);
  const result = await purgeExpiredTrashedThreads(now, client);
  assert.equal(result?.purged, total);
  assert.equal(rows().length, 0);
});

test("purgeExpiredTrashedThreads respeta el techo de PURGE_MAX_BATCHES por corrida y deja el resto para la próxima", async () => {
  const now = Date.now();
  const capacity = PURGE_BATCH_SIZE * PURGE_MAX_BATCHES;
  const total = capacity + 7;
  const seed = Array.from({ length: total }, (_, i) =>
    row({ id: `t${i}`, status: "trashed", deleted_at: iso(TRASH_RETENTION_MS + 60_000, now) }, now),
  );
  const { client, rows } = fakeClient(seed);
  const result = await purgeExpiredTrashedThreads(now, client);
  assert.equal(result?.purged, capacity, "se detiene en el techo de tandas, no sigue de largo");
  assert.equal(rows().length, total - capacity, "el sobrante queda para la corrida siguiente");
});
