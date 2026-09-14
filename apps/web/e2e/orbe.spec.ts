import { test, expect, type Page } from "@playwright/test";

/**
 * Audit del Orbe IA (WebGL) — reportado: "en Edge parpadea" y "en otras
 * plataformas a veces se ve negra". Se corre igual en chromium/msedge/
 * firefox/webkit (ver playwright.config.ts).
 *
 * IMPORTANTE sobre cómo se lee el píxel: el contexto se crea con
 * `preserveDrawingBuffer:false` (a propósito, por rendimiento — ver
 * OrbeIA.tsx). Con eso, el navegador tiene PERMITIDO limpiar el drawing
 * buffer entre fotogramas; un `gl.readPixels()` disparado desde una llamada
 * async SEPARADA (page.evaluate posterior al frame) puede leer ese estado ya
 * limpiado, no lo último que se dibujó — un falso negro que no corresponde a
 * nada que el usuario vea en pantalla (confirmado empíricamente: así leído,
 * salía negro tanto en el centro del orbe como en la ESQUINA, que el shader
 * pinta blanco SIEMPRE — imposible si de verdad hubiera dibujado eso).
 *
 * La lectura correcta —la que reflaja lo compuesto en pantalla— es via
 * `drawImage(canvasWebGL, ...)` sobre un canvas 2D, hecho DENTRO de un
 * `requestAnimationFrame` (mismo turno de composición que el bucle del
 * propio componente, no una tarea aparte).
 */

async function pixelCentral(page: Page): Promise<[number, number, number, number] | null> {
  return page.evaluate(
    () =>
      new Promise<[number, number, number, number] | null>((resolve) => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector("canvas");
          if (!canvas) return resolve(null);
          const off = document.createElement("canvas");
          off.width = canvas.width;
          off.height = canvas.height;
          const c2 = off.getContext("2d");
          if (!c2) return resolve(null);
          c2.drawImage(canvas, 0, 0);
          const d = c2.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
          resolve([d[0], d[1], d[2], d[3]]);
        });
      }),
  );
}

const esNegro = (px: readonly [number, number, number, number] | null) =>
  px !== null && px[0] < 8 && px[1] < 8 && px[2] < 8;

test.describe("Orbe IA — WebGL", () => {
  test("no hay errores de consola al montar", async ({ page }) => {
    const errores: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errores.push(msg.text());
    });
    await page.goto("/orbe");
    await page.waitForSelector("canvas");
    await page.waitForTimeout(1500); // dos vueltas largas del bucle a 30fps, de sobra
    const relevantes = errores.filter((e) => e.includes("OrbeIA") || e.includes("WebGL"));
    expect(relevantes, `errores de consola: ${relevantes.join(" | ")}`).toEqual([]);
  });

  test("nunca queda negro durante la carga (atlas/movimiento aún en vuelo)", async ({ page }) => {
    await page.goto("/orbe");
    await page.waitForSelector("canvas");
    // Muestreo agresivo desde el primer frame: si hay flash negro antes de
    // que carguen assets, es en esta ventana donde aparece.
    const muestras: (readonly [number, number, number, number] | null)[] = [];
    const fin = Date.now() + 2000;
    while (Date.now() < fin) {
      muestras.push(await pixelCentral(page));
      await page.waitForTimeout(30);
    }
    const negros = muestras.filter(esNegro);
    expect(
      negros.length,
      `${negros.length}/${muestras.length} muestras negras — primeras: ${JSON.stringify(negros.slice(0, 3))}`,
    ).toBe(0);
  });

  test("no parpadea en régimen estable (sin saltos negros entre fotogramas consecutivos)", async ({ page }) => {
    await page.goto("/orbe");
    await page.waitForSelector("canvas");
    await page.waitForTimeout(800); // deja que atlas+movimiento terminen de cargar
    const muestras: (readonly [number, number, number, number] | null)[] = [];
    for (let i = 0; i < 40; i++) {
      muestras.push(await pixelCentral(page));
      await page.waitForTimeout(16);
    }
    const negros = muestras.filter(esNegro);
    expect(negros.length, `parpadeo: ${negros.length}/${muestras.length} fotogramas negros en régimen estable`).toBe(
      0,
    );
  });

  test("recupera solo tras perder el contexto WebGL (antes se quedaba negro para siempre)", async ({ page }) => {
    await page.goto("/orbe");
    await page.waitForSelector("canvas");
    await page.waitForTimeout(800);

    const soportaPerdida = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
      return !!gl?.getExtension("WEBGL_lose_context");
    });
    test.skip(!soportaPerdida, "este navegador/motor no expone WEBGL_lose_context en este entorno");

    const antes = await pixelCentral(page);
    expect(esNegro(antes), `antes de perder contexto ya estaba negro: ${JSON.stringify(antes)}`).toBe(false);

    // Simula lo que dispara un cambio de GPU/driver inestable (el caso real
    // reportado): perder el contexto y, tras un respiro, restaurarlo —
    // exactamente el ciclo que dispara `webglcontextlost`/`webglcontextrestored`.
    // Todo en UN solo evaluate(): pedir `getExtension("WEBGL_lose_context")`
    // de nuevo en un evaluate() separado, ya con el contexto perdido, puede
    // devolver null en varios navegadores — hay que quedarse con la MISMA
    // referencia a la extensión que se usó para perderlo.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const canvas = document.querySelector("canvas")!;
          const gl = canvas.getContext("webgl") as WebGLRenderingContext;
          const ext = gl.getExtension("WEBGL_lose_context")!;
          ext.loseContext();
          setTimeout(() => {
            ext.restoreContext();
            resolve();
          }, 200);
        }),
    );
    // Le da tiempo al handler de `webglcontextrestored` a recrear
    // shaders/buffer/textura y retomar el bucle de fotogramas.
    await page.waitForTimeout(600);

    const despues = await pixelCentral(page);
    expect(
      esNegro(despues),
      `se quedó negro tras restaurar el contexto (regresión del fix): ${JSON.stringify(despues)}`,
    ).toBe(false);
  });
});
