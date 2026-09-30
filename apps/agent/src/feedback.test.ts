/**
 * Tests unitarios del buzón de mejoras (migración 033): listFeedback,
 * createFeedback, updateFeedbackStatus, deleteFeedback.
 *
 * Mismo patrón de doble en memoria que chat-threads.test.ts — un fake que
 * imita el subconjunto de PostgREST que feedback.ts realmente usa
 * (`.select().eq().eq().order()`, `.insert()...select().single()`,
 * `.update()...eq().eq().select().single()`, `.delete()...eq().eq()`).
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  listFeedback,
  createFeedback,
  updateFeedbackStatus,
  deleteFeedback,
  type Feedback,
} from "./feedback.js";

type Row = Record<string, unknown>;

function fakeClient(seed: Row[]) {
  let rows = seed.map((r) => ({ ...r }));
  let nextId = rows.length + 1;

  function from(_table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let single = false;

    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderCol = col;
        orderAsc = opts.ascending;
        return api;
      },
      insert(p: Row) {
        action = "insert";
        payload = p;
        return api;
      },
      update(p: Row) {
        action = "update";
        payload = p;
        return api;
      },
      delete() {
        action = "delete";
        return api;
      },
      single() {
        single = true;
        return api;
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        if (action === "insert") {
          const created = {
            id: `f${nextId++}`,
            // DEFAULT 'abierto' de la migración 033 — el fake lo imita porque
            // createFeedback() no manda `status` explícito en el insert real.
            status: "abierto",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_by: null,
            completed_at: null,
            ...payload,
          };
          rows.push(created);
          resolve({ data: single ? created : [created], error: null });
          return;
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (action === "update") {
          for (const r of matched) Object.assign(r, payload);
          const out = matched.map((r) => ({ ...r }));
          resolve({ data: single ? (out[0] ?? null) : out, error: null });
          return;
        }
        if (action === "delete") {
          const doomed = new Set(matched);
          rows = rows.filter((r) => !doomed.has(r));
          resolve({ data: null, error: null });
          return;
        }
        // select
        let out = matched;
        if (orderCol) {
          const col = orderCol;
          out = [...out].sort((a, b) => {
            const av = a[col] as string;
            const bv = b[col] as string;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return orderAsc ? cmp : -cmp;
          });
        }
        resolve({ data: out.map((r) => ({ ...r })), error: null });
      },
    };
    return api;
  }

  return { client: { from } as any, rows: () => rows };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "f1",
    user_id: "u1",
    project: "general",
    title: "Reporte de prueba",
    description: "Descripción de prueba",
    priority: 2,
    status: "abierto",
    images: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_by: null,
    completed_at: null,
    ...overrides,
  };
}

// ── listFeedback ─────────────────────────────────────────────────────────

test("listFeedback trae TODO el proyecto — buzón compartido, no filtra por user_id", async () => {
  const { client } = fakeClient([
    row({ id: "a", user_id: "u1", project: "general" }),
    row({ id: "b", user_id: "u2", project: "general" }),
    row({ id: "c", user_id: "u1", project: "otro" }),
  ]);
  const out = await listFeedback("general", undefined, client);
  // "a" Y "b" (de dos usuarios distintos) — solo "c" queda fuera, por ser de
  // OTRO proyecto, no por ser de otro usuario.
  assert.deepEqual(
    out.map((f) => f.id).sort(),
    ["a", "b"],
  );
});

test("listFeedback filtra por status cuando se pasa", async () => {
  const { client } = fakeClient([
    row({ id: "a", status: "abierto" }),
    row({ id: "b", status: "completado" }),
  ]);
  const out = await listFeedback("general", "completado", client);
  assert.deepEqual(out.map((f) => f.id), ["b"]);
});

test("listFeedback devuelve [] sin cliente configurado", async () => {
  const out = await listFeedback("general", undefined, null);
  assert.deepEqual(out, []);
});

// ── createFeedback ───────────────────────────────────────────────────────

test("createFeedback crea con status 'abierto' por defecto", async () => {
  const { client } = fakeClient([]);
  const created = await createFeedback(
    "u1",
    "general",
    "Título",
    "Descripción",
    2,
    undefined,
    client,
  );
  assert.equal(created.status, "abierto");
  assert.equal(created.user_id, "u1");
  assert.equal(created.priority, 2);
});

test("createFeedback exige un cliente configurado", async () => {
  await assert.rejects(() => createFeedback("u1", "general", "T", "D", 2, undefined, null));
});

// ── updateFeedbackStatus ─────────────────────────────────────────────────

test("updateFeedbackStatus a 'completado' setea completed_by y completed_at", async () => {
  const { client } = fakeClient([row({ id: "f1", user_id: "u1", status: "abierto" })]);
  const updated = await updateFeedbackStatus("f1", "completado", "samu-id", client);
  assert.ok(updated);
  assert.equal(updated!.status, "completado");
  assert.equal(updated!.completed_by, "samu-id");
  assert.ok(updated!.completed_at);
});

test("updateFeedbackStatus a 'abierto' limpia completed_by/completed_at", async () => {
  const { client } = fakeClient([
    row({ id: "f1", user_id: "u1", status: "completado", completed_by: "x", completed_at: "2026-01-01" }),
  ]);
  const updated = await updateFeedbackStatus("f1", "abierto", undefined, client);
  assert.ok(updated);
  assert.equal(updated!.completed_by, null);
  assert.equal(updated!.completed_at, null);
});

test("updateFeedbackStatus mueve CUALQUIER reporte, no solo el del que pregunta (buzón compartido)", async () => {
  const { client, rows } = fakeClient([row({ id: "f1", user_id: "u2", status: "abierto" })]);
  // "u1" no es el dueño (user_id: "u2") y aun así puede moverlo — es la
  // garantía central de este cambio: el buzón no está scoped por user_id.
  const result = await updateFeedbackStatus("f1", "en_revision", undefined, client);
  assert.ok(result);
  assert.equal(result!.status, "en_revision");
  assert.equal(rows()[0].status, "en_revision");
});

test("updateFeedbackStatus devuelve null si el id no existe", async () => {
  const { client } = fakeClient([row({ id: "f1", user_id: "u1", status: "abierto" })]);
  const result = await updateFeedbackStatus("no-existe", "completado", "samu-id", client);
  assert.equal(result, null);
});

// ── deleteFeedback ───────────────────────────────────────────────────────

test("deleteFeedback borra solo si coincide user_id", async () => {
  const { client, rows } = fakeClient([
    row({ id: "f1", user_id: "u1" }),
    row({ id: "f2", user_id: "u2" }),
  ]);
  await deleteFeedback("f1", "u1", client);
  assert.deepEqual(
    rows().map((r) => r.id),
    ["f2"],
  );
});

test("deleteFeedback no borra el reporte de otro usuario", async () => {
  const { client, rows } = fakeClient([row({ id: "f1", user_id: "u2" })]);
  await deleteFeedback("f1", "u1", client);
  assert.equal(rows().length, 1);
});
