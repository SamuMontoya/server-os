import { test, expect } from "@playwright/test";

/**
 * Subida de documentos del composer (el clip) — audit pedido por Samu
 * (2026-09-15): "solo deja cargar 5 documentos y es lento; que deje cargar
 * los que se quiera, progresivo, y más rápido".
 *
 * Dos rediseños encima del original (mismo día, misma auditoría):
 *  1. Cada archivo viaja en SU PROPIO request a `/chat/documents` (antes era
 *     una sola tanda) — el chip de cada uno debe pasar de estado en cuanto
 *     SU trabajo resuelve, sin esperar a los demás.
 *  2. ASÍNCRONO: `POST /chat/documents` ya NO tarda lo que tarda vectorizar
 *     (Ollama serial en 1 vCPU podía tardar minutos) — responde YA con el
 *     docId en "processing", y el composer hace POLLING a
 *     `GET /chat/documents/status` hasta ver "ready"/"error". El chip pasa
 *     por "uploading" (bytes viajando, msegundos) → "processing" (vectorizando
 *     en background, ya NO bloquea el envío del mensaje) → "done"/"error".
 *
 * Este test NO pega contra el agente real (Ollama/Supabase reales serían
 * lentos, no deterministas y ensuciarían `chat_docs` en cada corrida) — se
 * interceptan AMBOS endpoints con `page.route` y se controla a mano cuánto
 * tarda cada documento en "terminar" (vía el mock de `/status`), para poder
 * afirmar el ORDEN de finalización sin depender de infra real ni de esperar
 * minutos por Ollama.
 */

test.describe("Laboratorio — subida de documentos (el clip)", () => {
  test("cada archivo se resuelve de forma independiente y progresiva, no en bloque", async ({ page }) => {
    // Cuánto debe pasar (desde que el POST aceptó el archivo) antes de que
    // el mock de /status dé por terminado ese documento. "lento.txt" pasa
    // aposta el intervalo de polling del composer (1500ms, DOC_STATUS_POLL_MS
    // en laboratorio/page.tsx) para poder observar un momento intermedio
    // real: tras el primer tick de polling, rápido y malo ya resolvieron
    // pero lento sigue "processing" — algo que antes (todo síncrono) no
    // existía como estado observable.
    const TIEMPOS: Record<string, number> = { "rapido.txt": 100, "malo.pdf": 100, "lento.txt": 2200 };
    const docIdDe = (nombre: string) => `${nombre}-docid`;
    const nombreDeDocId = (docId: string) => docId.replace(/-docid$/, "");
    const startedAt = new Map<string, number>();

    // El POST ya NO simula tardanza: siempre responde rápido con "processing"
    // (eso es justo lo que cambió — antes el fetch entero tardaba lo que
    // tarda vectorizar). Quien decide cuándo "termina" cada uno es el mock
    // de /status, más abajo.
    await page.route("**/chat/documents", async (route) => {
      const body = route.request().postData() ?? "";
      const nombre = /filename="([^"]+)"/.exec(body)?.[1] ?? "desconocido";
      const docId = docIdDe(nombre);
      startedAt.set(docId, Date.now());
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ processing: [{ name: nombre, docId, status: "processing" }] }),
      });
    });

    await page.route("**/chat/documents/status**", async (route) => {
      const url = new URL(route.request().url());
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const jobs = ids.map((docId) => {
        const nombre = nombreDeDocId(docId);
        const elapsed = Date.now() - (startedAt.get(docId) ?? Date.now());
        const umbral = TIEMPOS[nombre] ?? 0;
        if (elapsed < umbral) return { docId, status: "processing" as const };
        if (nombre === "malo.pdf") {
          return { docId, status: "error" as const, name: nombre, error: "no se pudo vectorizar (prueba)" };
        }
        return { docId, status: "ready" as const, name: nombre, chunks: 1, chars: 20, truncated: false };
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs }),
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

    // Arrancan los tres subiendo/procesando (misma clase visual para ambos
    // estados transitorios — ver lab-chip--uploading en laboratorio/page.tsx).
    await expect(chipDe("rapido.txt")).toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("lento.txt")).toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("malo.pdf")).toHaveClass(/lab-chip--uploading/);

    // Tras el PRIMER tick de polling (~1500ms): rápido y malo, cuyo umbral
    // (100ms) ya se cumplió hace rato, deben haber cambiado de estado.
    // Lento (umbral 2200ms) sigue "processing" — esto es lo que antes NO
    // existía (todo síncrono, todos los chips saltaban juntos al final).
    await page.waitForTimeout(1800);
    await expect(chipDe("rapido.txt")).not.toHaveClass(/lab-chip--uploading/);
    await expect(chipDe("rapido.txt")).not.toHaveClass(/lab-chip--error/);
    await expect(chipDe("malo.pdf")).toHaveClass(/lab-chip--error/);
    await expect(chipDe("lento.txt")).toHaveClass(/lab-chip--uploading/);

    // Y en el SEGUNDO tick (~3000ms desde el inicio), lento también resuelve
    // solo — su umbral (2200ms) ya se cumplió para entonces.
    await expect(chipDe("lento.txt")).not.toHaveClass(/lab-chip--uploading/, { timeout: 3000 });
    await expect(chipDe("lento.txt")).not.toHaveClass(/lab-chip--error/);
  });

  test("mientras un documento sigue 'processing' en background, el mensaje se puede mandar igual (no bloquea)", async ({
    page,
  }) => {
    // El pedido explícito de Samu (2026-09-15): "que se pueda seguir
    // chateando o subir más documentos mientras otros procesan". Antes de
    // este cambio, CUALQUIER documento en curso bloqueaba `canSend` entero.
    await page.route("**/chat/documents", async (route) => {
      const body = route.request().postData() ?? "";
      const nombre = /filename="([^"]+)"/.exec(body)?.[1] ?? "desconocido";
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          processing: [{ name: nombre, docId: `${nombre}-docid`, status: "processing" }],
        }),
      });
    });
    // El /status NUNCA resuelve durante este test — a propósito: lo que se
    // prueba es que "processing" (a diferencia de "uploading") no bloquea.
    await page.route("**/chat/documents/status**", async (route) => {
      const url = new URL(route.request().url());
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: ids.map((docId) => ({ docId, status: "processing" as const })) }),
      });
    });

    await page.goto("/laboratorio");
    const nuevoChat = page.getByRole("button", { name: /nuevo chat|empezar/i }).first();
    if (await nuevoChat.isVisible().catch(() => false)) await nuevoChat.click();

    const input = page.locator("input.lab-file-input-hidden");
    await input.setInputFiles([
      { name: "en-proceso.txt", mimeType: "text/plain", buffer: Buffer.from("contenido") },
    ]);

    // Deja que el POST resuelva y el chip pase de "uploading" (bytes) a
    // "processing" (vectorizando en background) — la clase visual no
    // distingue ambos, pero el botón de enviar sí debe hacerlo.
    await expect(page.locator(".lab-chip--doc")).toHaveCount(1);

    const composer = page.locator("textarea.lab-composer-input, textarea").first();
    await composer.fill("¿qué dice el documento?");

    const enviar = page.getByRole("button", { name: /enviar/i }).first();
    // No debe estar deshabilitado: hay texto Y el documento, aunque siga
    // "processing", ya no cuenta como bloqueo.
    await expect(enviar).toBeEnabled({ timeout: 4000 });
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
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          processing: [{ name: nombre, docId: `${nombre}-docid`, status: "processing" }],
        }),
      });
    });
    await page.route("**/chat/documents/status**", async (route) => {
      const url = new URL(route.request().url());
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobs: ids.map((docId) => ({
            docId,
            status: "ready" as const,
            name: docId.replace(/-docid$/, ""),
            chunks: 1,
            chars: 10,
            truncated: false,
          })),
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
