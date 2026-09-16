import { test, expect } from "@playwright/test";

/**
 * Papelera de chats (pedido de Jaime 2026-09-16): eliminar un chat ya no lo
 * borra — lo manda a una sección "Papelera" con 30 días de gracia y opción
 * de restaurar (ver TRASH_RETENTION_MS en chat-threads.ts del agente,
 * lab-persist.ts y LabChatsScreen.tsx). El backend (`/chat/threads*`) se
 * intercepta con `page.route`, mismo criterio que lab-doc-upload.spec.ts:
 * es determinista, no ensucia Supabase de verdad, y no depende de que el
 * motor de turnos real esté corriendo.
 *
 * A diferencia de jaime-os (donde esta suite necesita una sesión real de
 * Supabase, ver env.ts/global-setup.ts allá), este frontend LOCAL no exige
 * login — mismo patrón que el resto de e2e/ en este repo (composer-resize,
 * lab-doc-upload): sin `test.skip`, corre directo.
 *
 * Mismo spec duplicado en `jaime-os/e2e/lab-trash.spec.ts` (los dos
 * frontends comparten laboratorio/page.tsx casi al carácter).
 */
test.describe("Laboratorio — papelera de chats", () => {
  const AHORA = Date.now();
  const UN_DIA_MS = 24 * 60 * 60 * 1000;

  const threadMeta = (over: Record<string, unknown>) => ({
    id: "x",
    title: "Chat de prueba",
    updatedAt: AHORA,
    model: null,
    sdkSessionId: null,
    pendingTurn: null,
    status: "active",
    deletedAt: null,
    ...over,
  });

  const threadFull = (over: Record<string, unknown>) => ({
    ...threadMeta(over),
    project: "general",
    sessionKey: "sesion-1",
    messages: [{ id: 1, role: "user", content: "hola, este es un chat de prueba" }],
    draft: "",
  });

  /** Rutas comunes que cualquier carga del laboratorio dispara best-effort:
   *  autosave (`PUT`) y "cuál quedó activo" — sin esto Playwright loguea
   *  requests sin responder de fondo (no rompe el test, pero ensucia). */
  async function mockearRutasComunes(page: import("@playwright/test").Page) {
    await page.route("**/chat/active", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    await page.route("**/chat/threads/*", (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fallback();
    });
  }

  test("un chat trashed llegado del servidor aparece en la Papelera, colapsada, con 'Restaurar'", async ({
    page,
  }) => {
    await mockearRutasComunes(page);

    await page.route("**/chat/threads?project=general&status=active", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ threads: [], activeId: null }),
      }),
    );
    await page.route("**/chat/threads?project=general&status=trashed", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          threads: [threadMeta({ id: "trashed-1", title: "Chat eliminado", status: "trashed", deletedAt: AHORA - 5 * UN_DIA_MS })],
          activeId: null,
        }),
      }),
    );
    let restaurado = false;
    await page.route("**/chat/threads/trashed-1", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(threadFull({ id: "trashed-1", title: "Chat eliminado" })),
        });
      }
      return route.fallback();
    });
    await page.route("**/chat/threads/trashed-1/restore", (route) => {
      restaurado = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    // A diferencia de jaime-os, acá la pantalla de chats arranca ABIERTA
    // (`useState(true)` en laboratorio/page.tsx de este repo) — no hace
    // falta tocar la hamburguesa para verla.
    await page.goto("/laboratorio");

    const toggle = page.getByRole("button", { name: /Papelera/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Chat eliminado")).not.toBeVisible();

    await toggle.click();
    await expect(page.getByText("Chat eliminado")).toBeVisible();
    await expect(page.getByText(/Se elimina en \d+ días/)).toBeVisible();

    await page.getByRole("button", { name: "Restaurar" }).click();
    await expect.poll(() => restaurado).toBe(true);
  });

  test("swipe a la izquierda sobre un chat activo lo manda a la Papelera (DELETE llega como soft-delete)", async ({
    page,
  }) => {
    await mockearRutasComunes(page);

    await page.route("**/chat/threads?project=general&status=active", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          threads: [threadMeta({ id: "activo-1", title: "Chat a borrar" })],
          activeId: null,
        }),
      }),
    );
    await page.route("**/chat/threads?project=general&status=trashed", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ threads: [], activeId: null }),
      }),
    );
    let deleteLlamado = false;
    await page.route("**/chat/threads/activo-1", (route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(threadFull({ id: "activo-1", title: "Chat a borrar" })),
        });
      }
      if (method === "DELETE") {
        deleteLlamado = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fallback();
    });

    // A diferencia de jaime-os, acá la pantalla de chats arranca ABIERTA
    // (`useState(true)` en laboratorio/page.tsx de este repo) — no hace
    // falta tocar la hamburguesa para verla.
    await page.goto("/laboratorio");

    const fila = page.locator(".lab-chatcard", { hasText: "Chat a borrar" });
    await expect(fila).toBeVisible();

    // Simula el swipe con eventos de puntero reales (Playwright los dispara
    // como pointer events de verdad en Chromium/WebKit, que es lo que
    // SwipeableCard escucha — ver LabChatsScreen.tsx).
    const box = await fila.boundingBox();
    if (!box) throw new Error("no se encontró la card a arrastrar");
    const startX = box.x + box.width - 10;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 140, y, { steps: 8 }); // > SWIPE_COMMIT_PX (88)
    await page.mouse.up();

    await expect.poll(() => deleteLlamado).toBe(true);
    // El chat sale de la lista principal...
    await expect(page.locator(".lab-chatcard", { hasText: "Chat a borrar" })).toHaveCount(0);
    // ...y aparece en la Papelera, restaurable. Selector acotado a la fila de
    // la papelera (`.lab-chats-trash-title`): el texto plano "Chat a borrar"
    // también matchea el chip de sugerencia "Seguir con chat a borrar" de la
    // pantalla en blanco, que sigue vivo detrás de este diálogo.
    await page.getByRole("button", { name: /Papelera/i }).click();
    await expect(page.locator(".lab-chats-trash-title", { hasText: "Chat a borrar" })).toBeVisible();
  });
});
