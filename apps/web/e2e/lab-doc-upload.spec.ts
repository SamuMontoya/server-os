import { test, expect } from "@playwright/test";

/**
 * Subida de documentos del composer (el clip) — audit pedido por Samu
 * (2026-09-15): "solo deja cargar 5 documentos y es lento; que deje cargar
 * los que se quiera, progresivo, y más rápido".
 *
 * El rediseño real es:
 *  1. Cada archivo viaja en SU PROPIO request a `/chat/documents` (antes era
 *     una sola tanda) — el chip de cada uno debe pasar a "listo"/"error" en
 *     cuanto SU request resuelve, sin esperar a los demás.
 *  2. `DOC_UPLOAD_CONCURRENCY = 2` en el composer: máximo 2 requests en
 *     vuelo a la vez (ver `addDocuments`, laboratorio/page.tsx).
 *
 * Este test NO pega contra el agente real (Ollama/Supabase reales serían
 * lentos, no deterministas y ensuciarían `chat_docs` en cada corrida) — se
 * intercepta `/chat/documents` con `page.route` y se controla el tiempo de
 * cada respuesta a mano, para poder afirmar el ORDEN de finalización sin
 * depender de infra real.
 */

test.describe("Laboratorio — subida de documentos (el clip)", () => {
  test("cada archivo se resuelve de forma independiente y progresiva, no en bloque", async ({ page }) => {
    // Tres archivos con tiempos de respuesta distintos, para poder observar
    // un momento intermedio donde unos ya terminaron y otro sigue en vuelo.
    // Con concurrencia 2, "rapido" y "lento" arrancan juntos; "malo" espera
    // a que se libere un cupo (lo libera "rapido", el más corto).
    const TIEMPOS: Record<string, number> = { "rapido.txt": 60, "malo.pdf": 60, "lento.txt": 900 };

    await page.route("**/chat/documents", async (route) => {
      const body = route.request().postData() ?? "";
      const nombre = /filename="([^"]+)"/.exec(body)?.[1] ?? "desconocido";
      await new Promise((r) => setTimeout(r, TIEMPOS[nombre] ?? 60));

      if (nombre === "malo.pdf") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: [], failed: [{ name: nombre, error: "no se pudo vectorizar (prueba)" }] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: [{ name: nombre, docId: "e2e-doc-id", chunks: 1, chars: 20, truncated: false }],
          failed: [],
        }),
      });
    });

    await page.goto("/laboratorio");
    // El menú de chats abre por encima al cargar (ver showChats=true por
    // defecto) — hay que entrar a un chat antes de que el composer exista.
    const nuevoChat = page.getByRole("button", { name: /nuevo chat|empezar/i }).first();
    if (await nuevoChat.isVisible().catch(() => false)) await nuevoChat.click();

    const input = page.locator("input.lab-file-input-hidden");
    await input.setInputFiles([
      { name: "rapido.txt", mimeType: "text/plain", buffer: Buffer.from("contenido rápido") },
      { name: "lento.txt", mimeType: "text/plain", buffer: Buffer.from("contenido lento") },
      { name: "malo.pdf", mimeType: "application/pdf", buffer: Buffer.from("contenido malo") },
    ]);

    const chipDe = (nombre: string) => page.locator(".lab-chip--doc").filter({ hasText: nombre });

    // Arrancan los tres subiendo.
    await expect(chipDe("rapido.txt")).toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("lento.txt")).toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("malo.pdf")).toHaveClass(/lab-chip--uploading/);

    // A mitad de camino (después de que rapido y malo resolvieron, MUCHO
    // antes de que lento lo haga): rapido y malo ya deben haber cambiado de
    // estado, lento debe seguir "subiendo". Esto es lo que antes NO pasaba
    // (todos los chips saltaban juntos al final de la tanda completa).
    await page.waitForTimeout(400);
    await expect(chipDe("rapido.txt")).not.toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("rapido.txt")).not.toHaveClass(/lab-chip--error/);
    await expect(chipDe("malo.pdf")).toHaveClass(/lab-chip--error/);
    await expect(chipDe("lento.txt")).toHaveClass(/lab-chip--uploading/);

    // Y al final, lento también resuelve solo.
    await expect(chipDe("lento.txt")).not.toHaveClass(/lab-chip--uploading/, { timeout: 3000 });
    await expect(chipDe("lento.txt")).not.toHaveClass(/lab-chip--error/);
  });

  test("pasarse del máximo por mensaje marca un chip de rechazo explícito, no descarta en silencio", async ({
    page,
  }) => {
    // MAX_DOCUMENTS vive hardcodeado en laboratorio/page.tsx (no se expone
    // como export ni env — es un límite de cordura de la UI, no de negocio).
    // Si cambia ahí, hay que actualizar este número también.
    const MAX_DOCUMENTS = 30;

    await page.route("**/chat/documents", async (route) => {
      const body = route.request().postData() ?? "";
      const nombre = /filename="([^"]+)"/.exec(body)?.[1] ?? "desconocido";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: [{ name: nombre, docId: "e2e-doc-id", chunks: 1, chars: 10, truncated: false }],
          failed: [],
        }),
      });
    });

    await page.goto("/laboratorio");
    const nuevoChat = page.getByRole("button", { name: /nuevo chat|empezar/i }).first();
    if (await nuevoChat.isVisible().catch(() => false)) await nuevoChat.click();

    // Uno de más: antes `docs.slice(0, room)` lo recortaba en silencio, sin
    // ningún rastro en la UI. Ahora debe aparecer un chip de error explícito.
    const archivos = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => ({
      name: `doc-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`contenido ${i}`),
    }));

    const input = page.locator("input.lab-file-input-hidden");
    await input.setInputFiles(archivos);

    // El chip de rechazo aparece de inmediato (no depende del fetch): dice
    // cuántos no entraron y por qué, en vez de desaparecer sin dejar rastro.
    await expect(page.locator(".lab-chip--error").filter({ hasText: "no se subió" })).toBeVisible();
    await expect(page.locator(".lab-chip--doc")).toHaveCount(MAX_DOCUMENTS + 1); // 30 en curso + 1 de rechazo
  });
});
