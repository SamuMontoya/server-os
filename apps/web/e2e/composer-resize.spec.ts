import { test, expect } from "@playwright/test";

/**
 * Techo dinámico del composer (pedido de Samu 2026-09-15): el textarea del
 * chat debe crecer con cada línea nueva hasta rozar la barra superior —ya no
 * un tope fijo de 120px— y entrar en scroll interno una vez ahí, sin nunca
 * pisar/tapar `.lab-topbar`.
 *
 * Se fuerza un viewport chico (600px de alto) para que sea fácil llegar al
 * techo con pocas líneas, sin depender de cuántas hacen falta en una pantalla
 * grande.
 */
test.describe("Laboratorio — composer con alto dinámico", () => {
  test.use({ viewport: { width: 390, height: 600 } });

  test("el textarea crece más allá de 120px y nunca tapa la barra superior", async ({ page }) => {
    await page.goto("/laboratorio");
    const nuevoChat = page.getByRole("button", { name: /nuevo chat|empezar/i }).first();
    if (await nuevoChat.isVisible().catch(() => false)) await nuevoChat.click();

    const textarea = page.locator(".lab-textarea");
    await expect(textarea).toBeVisible();
    const topbar = page.locator(".lab-topbar");

    const alturaInicial = (await textarea.boundingBox())!.height;
    expect(alturaInicial).toBeLessThan(40); // ~28px, una línea

    // 25 líneas: de sobra para superar el viejo tope de 120px en un viewport
    // de 600px de alto. `fill()`, no `pressSequentially`: Enter sin Shift
    // ENVÍA el mensaje (ver onKeyDown más abajo en este archivo) — con
    // pressSequentially cada "\n" dispararía un submit real en vez de
    // insertar una línea nueva.
    await textarea.fill(Array(25).fill("línea").join("\n"));

    await expect(async () => {
      const h = (await textarea.boundingBox())!.height;
      expect(h).toBeGreaterThan(120);
    }).toPass({ timeout: 2000 });

    // El techo real: el borde de arriba del textarea nunca sube por encima
    // del borde de abajo de la barra superior (con algo de margen razonable,
    // el GAP de 12px que pone resizeInput más el propio padding del composer).
    const cajaTextarea = (await textarea.boundingBox())!;
    const cajaTopbar = (await topbar.boundingBox())!;
    expect(cajaTextarea.y).toBeGreaterThanOrEqual(cajaTopbar.y + cajaTopbar.height);

    // Con el techo alcanzado, el contenido de más entra en scroll interno
    // (no sigue empujando el layout): scrollHeight > clientHeight.
    const [scrollHeight, clientHeight] = await textarea.evaluate((el: HTMLTextAreaElement) => [
      el.scrollHeight,
      el.clientHeight,
    ]);
    expect(scrollHeight).toBeGreaterThan(clientHeight);
  });
});
