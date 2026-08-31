#!/usr/bin/env node
/**
 * shot.mjs — auditoría visual de la web de HERMES OS.
 *
 * Toma un screenshot de una pantalla, opcionalmente emulando un móvil y el
 * teclado virtual, e imprime un reporte JSON con las medidas del viewport y los
 * colores de fondo. Sirve para responder cosas como "¿por qué queda una banda
 * blanca abajo cuando se abre el teclado?" sin tener que mirar el móvil.
 *
 * ─── LIMITACIÓN CONOCIDA: --keyboard y visualViewport ────────────────────────
 *
 * `--keyboard <px>` simula el teclado virtual encogiendo el viewport por CDP
 * (`Emulation.setDeviceMetricsOverride`). Eso reproduce fielmente lo que ve el
 * usuario en el caso que importa (el layout se recalcula contra un alto menor,
 * que es lo que hace Chrome en Android con `interactive-widget=resizes-content`,
 * el default), pero NO es idéntico a un teclado real:
 *
 *   - `window.innerHeight` SÍ cambia: pasa a ser el alto reducido.
 *   - `window.visualViewport.height` SÍ sigue al override en Chromium moderno,
 *     porque el visual viewport se deriva de las device metrics. Lo que NO se
 *     puede forzar por CDP es un `offsetTop` distinto de 0: un teclado real con
 *     `interactive-widget=overlays-content` deja el layout viewport intacto y
 *     solo desplaza/encoge el visual viewport. Ese caso no se reproduce aquí.
 *   - El evento `resize` de `window.visualViewport` no lo emite el override de
 *     forma fiable, así que lo disparamos a mano (ver `dispararResize`). Es un
 *     evento sintético: `event.isTrusted === false`. Un listener que filtre por
 *     `isTrusted` no reaccionará. Ninguno del código de la app lo hace hoy.
 *
 * En resumen: para auditar "el contenido se recoloca bien cuando baja el alto
 * disponible", esto vale. Para auditar overlay puro de teclado sobre un layout
 * que no se encoge, hay que probar en un dispositivo real.
 *
 * ─── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   node shot.mjs --url http://localhost:31415/laboratorio --device mobile
 *   node shot.mjs --url http://localhost:31415/laboratorio --keyboard 300 \
 *                 --click "input" --probe-pixels
 *
 * Ver todas las opciones con `--help`.
 */

import { chromium, devices } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Modo --static: bypass de auth para auditar rutas protegidas
// ─────────────────────────────────────────────────────────────────────────────
//
// El dashboard entero vive detrás de login de Google vía Supabase
// (apps/web/src/middleware.ts). Playwright headless no puede completar ese
// flujo, así que auditar http://localhost:31415/<ruta> directamente solo
// enseña la pantalla de /login — un screenshot que parece válido pero no lo es.
//
// Next exporta cada ruta estática ya renderizada en
// .next/server/app/<ruta>.html. El matcher del middleware excluye `_next/*`
// de la comprobación de sesión, así que los chunks JS/CSS sí se sirven sin
// auth desde el puerto real. Este servidor efímero sirve ese HTML en "/" y
// proxea todo lo demás (_next/*, favicon, etc.) al servidor real: el
// navegador hidrata la página REAL, con su JS y CSS de verdad, sin sesión.
const NEXT_APP_DIR = path.resolve(
  __dirname,
  "../../apps/web/.next/server/app",
);

async function servirEstatico(rutaApp, targetOrigin) {
  const rutaHtml = path.join(NEXT_APP_DIR, `${rutaApp.replace(/^\/+/, "")}.html`);
  if (!existsSync(rutaHtml)) {
    throw new Error(
      `No existe el HTML prerenderizado para "${rutaApp}": ${rutaHtml}\n` +
        `¿Falta un build? (pnpm --filter @hermes/web build)`,
    );
  }
  const html = await readFile(rutaHtml);

  const servidor = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    // Todo lo demás (_next/static, _next/image, favicon.ico...) se proxea tal
    // cual al servidor real. Esas rutas no requieren sesión.
    const upstream = http.request(
      targetOrigin + req.url,
      { method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });
    req.pipe(upstream);
  });

  await new Promise((resolve, reject) => {
    servidor.on("error", reject);
    servidor.listen(0, "127.0.0.1", resolve);
  });

  const { port } = servidor.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    cerrar: () => new Promise((r) => servidor.close(r)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argumentos
// ─────────────────────────────────────────────────────────────────────────────

const AYUDA = `
shot.mjs — screenshots + reporte de layout para la web de HERMES OS

Opciones:
  --url <url>          URL a capturar        (default: http://localhost:31415/)
  --out <ruta.png>     PNG de salida         (default: ./shots/<timestamp>.png)
  --device <nombre>    mobile | desktop      (default: mobile)
                         mobile  = 390x844, dsf 3, isMobile + hasTouch
                         desktop = 1440x900, dsf 1
  --keyboard <px>      Simula el teclado virtual encogiendo el viewport <px>.
                       Ver la LIMITACIÓN CONOCIDA en la cabecera del archivo.
  --wait <ms>          Espera extra antes del shot          (default: 400)
  --click <selector>   Hace clic en el selector antes del shot (p.ej. enfocar
                       un input). Se aplica ANTES de --keyboard.
  --fullpage           Captura la página entera, no solo el viewport.
  --probe-pixels       Lee colores de píxel del PNG (centro, borde inferior,
                       esquinas) y los añade al JSON.
  --storage <ruta>     storageState de Playwright (JSON) para páginas con
                       sesión iniciada. Sin esto, las rutas protegidas
                       redirigen a /login.
  --static <ruta>      Bypass de auth: sirve .next/server/app/<ruta>.html en
                       un servidor local efímero (proxeando _next/* al
                       --target-origin real) y navega ahí en vez de a --url.
                       Usar para auditar rutas del dashboard protegidas por
                       login, que Playwright headless no puede completar.
                       Ej: --static laboratorio
  --target-origin <url> Origen real al que proxear _next/* en modo --static
                       (default: http://localhost:31415)
  --timeout <ms>       Timeout de navegación                (default: 30000)
  --help               Esta ayuda.

Salida: la ruta absoluta del PNG en la primera línea, y luego el reporte JSON.
`.trim();

function parsearArgs(argv) {
  const opciones = {
    url: "http://localhost:31415/",
    out: null,
    device: "mobile",
    keyboard: 0,
    wait: 400,
    click: null,
    fullpage: false,
    probePixels: false,
    storage: null,
    static: null,
    targetOrigin: "http://localhost:31415",
    timeout: 30000,
  };

  const banderas = new Set(["--fullpage", "--probe-pixels", "--help", "-h"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // El valor de una opción con argumento es el siguiente token. Se valida que
    // exista para que `--keyboard` sin número no acabe en NaN silencioso.
    const valor = () => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && !banderas.has(arg))) {
        throw new Error(`La opción ${arg} necesita un valor.`);
      }
      i++;
      return v;
    };

    switch (arg) {
      case "--help":
      case "-h":
        console.log(AYUDA);
        process.exit(0);
        break;
      case "--url":
        opciones.url = valor();
        break;
      case "--out":
        opciones.out = valor();
        break;
      case "--device":
        opciones.device = valor();
        break;
      case "--keyboard":
        opciones.keyboard = Number(valor());
        break;
      case "--wait":
        opciones.wait = Number(valor());
        break;
      case "--click":
        opciones.click = valor();
        break;
      case "--fullpage":
        opciones.fullpage = true;
        break;
      case "--probe-pixels":
        opciones.probePixels = true;
        break;
      case "--storage":
        opciones.storage = valor();
        break;
      case "--static":
        opciones.static = valor();
        break;
      case "--target-origin":
        opciones.targetOrigin = valor();
        break;
      case "--timeout":
        opciones.timeout = Number(valor());
        break;
      default:
        throw new Error(`Opción desconocida: ${arg}\n\n${AYUDA}`);
    }
  }

  for (const clave of ["keyboard", "wait", "timeout"]) {
    if (!Number.isFinite(opciones[clave])) {
      throw new Error(`--${clave} tiene que ser un número.`);
    }
  }
  if (!PERFILES[opciones.device]) {
    throw new Error(
      `--device tiene que ser uno de: ${Object.keys(PERFILES).join(", ")}`,
    );
  }

  return opciones;
}

// ─────────────────────────────────────────────────────────────────────────────
// Perfiles de dispositivo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `mobile` copia el user agent del iPhone 13 del catálogo de Playwright pero
 * fija a mano el viewport y el dsf: así el tamaño no cambia si Playwright
 * actualiza el catálogo, que es justo lo que rompería una comparación entre dos
 * auditorías tomadas en fechas distintas.
 */
const PERFILES = {
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: devices["iPhone 13"]?.userAgent,
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Teclado virtual
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encoge el viewport por CDP para imitar el hueco que deja el teclado virtual.
 *
 * `page.setViewportSize()` no sirve aquí: redimensiona la ventana entera, así
 * que el layout viewport y el visual viewport se mueven juntos y el screenshot
 * sale del tamaño nuevo. Con `Emulation.setDeviceMetricsOverride` el frame se
 * renderiza al alto reducido, que es lo que queremos ver.
 */
async function simularTeclado(page, perfil, px) {
  const cdp = await page.context().newCDPSession(page);
  const altoReducido = perfil.viewport.height - px;

  if (altoReducido <= 0) {
    throw new Error(
      `--keyboard ${px} deja el viewport en ${altoReducido}px de alto (el ` +
        `dispositivo mide ${perfil.viewport.height}px). Usa un valor menor.`,
    );
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: perfil.viewport.width,
    height: altoReducido,
    deviceScaleFactor: perfil.deviceScaleFactor,
    mobile: perfil.isMobile,
    screenOrientation: { angle: 0, type: "portraitPrimary" },
  });

  // El override no emite `resize` sobre visualViewport de forma fiable. Se
  // dispara a mano para que el código que escucha ese evento (barras fijas,
  // autoscroll al input) reaccione. Es sintético: isTrusted === false.
  const resizeDisparado = await page.evaluate(() => {
    try {
      window.dispatchEvent(new Event("resize"));
      if (window.visualViewport) {
        window.visualViewport.dispatchEvent(new Event("resize"));
        window.visualViewport.dispatchEvent(new Event("scroll"));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  return { altoReducido, resizeDisparado, cdp };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporte de layout
// ─────────────────────────────────────────────────────────────────────────────

async function medirLayout(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const se = document.scrollingElement || html;
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      visualViewport: window.visualViewport
        ? {
            height: window.visualViewport.height,
            width: window.visualViewport.width,
            offsetTop: window.visualViewport.offsetTop,
            scale: window.visualViewport.scale,
          }
        : null,
      scrollTop: se ? se.scrollTop : null,
      scrollHeight: se ? se.scrollHeight : null,
      clientHeight: se ? se.clientHeight : null,
      backgroundColor: {
        html: getComputedStyle(html).backgroundColor,
        body: getComputedStyle(body).backgroundColor,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sonda de píxeles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lee colores del PNG ya generado.
 *
 * Sin dependencias de decodificación: se abre una página en blanco del mismo
 * Chromium, se carga el PNG como dataURL en un <canvas> y se leen los píxeles
 * con getImageData. El navegador ya sabe decodificar PNG; meter `sharp` solo
 * para esto sería traer un binario nativo por nada.
 *
 * Las coordenadas son en píxeles del PNG (que con dsf 3 es 3x el viewport CSS),
 * así que el reporte incluye ambos: `punto` en px de imagen.
 */
async function sondearPixeles(context, rutaPng) {
  const png = await readFile(rutaPng);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  const pagina = await context.newPage();
  try {
    await pagina.goto("about:blank");
    return await pagina.evaluate(async (url) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("No se pudo decodificar el PNG."));
        img.src = url;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const w = canvas.width;
      const h = canvas.height;

      // Las esquinas se leen 1px hacia dentro: el borde exacto puede llevar
      // antialias del redondeado y daría un color que no es el del fondo.
      const puntos = {
        centro: [Math.floor(w / 2), Math.floor(h / 2)],
        bordeInferior: [Math.floor(w / 2), h - 1],
        bordeSuperior: [Math.floor(w / 2), 0],
        esquinaSupIzq: [1, 1],
        esquinaSupDer: [w - 2, 1],
        esquinaInfIzq: [1, h - 2],
        esquinaInfDer: [w - 2, h - 2],
      };

      const leer = ([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        const hex =
          "#" +
          [d[0], d[1], d[2]]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("");
        return {
          punto: [x, y],
          rgba: `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(3)})`,
          hex,
        };
      };

      const salida = { dimensionesPng: { width: w, height: h } };
      for (const [nombre, punto] of Object.entries(puntos)) {
        salida[nombre] = leer(punto);
      }
      return salida;
    }, dataUrl);
  } finally {
    await pagina.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const opciones = parsearArgs(process.argv.slice(2));
  const perfil = PERFILES[opciones.device];

  const rutaSalida = path.resolve(
    opciones.out ||
      path.join(
        "shots",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      ),
  );
  await mkdir(path.dirname(rutaSalida), { recursive: true });

  if (opciones.storage && !existsSync(opciones.storage)) {
    throw new Error(`No existe el storageState: ${opciones.storage}`);
  }

  let estatico = null;
  let urlObjetivo = opciones.url;
  if (opciones.static) {
    estatico = await servirEstatico(opciones.static, opciones.targetOrigin);
    urlObjetivo = estatico.url;
  }

  const navegador = await chromium.launch();
  const context = await navegador.newContext({
    viewport: perfil.viewport,
    deviceScaleFactor: perfil.deviceScaleFactor,
    isMobile: perfil.isMobile,
    hasTouch: perfil.hasTouch,
    ...(perfil.userAgent ? { userAgent: perfil.userAgent } : {}),
    ...(opciones.storage ? { storageState: opciones.storage } : {}),
  });

  const reporte = {
    url: urlObjetivo,
    device: opciones.device,
    viewportSolicitado: perfil.viewport,
    deviceScaleFactor: perfil.deviceScaleFactor,
    keyboardPx: opciones.keyboard || 0,
  };
  if (estatico) {
    reporte.staticMode = { ruta: opciones.static, proxyUrl: estatico.url };
  }

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(opciones.timeout);

    const respuesta = await page.goto(urlObjetivo, {
      waitUntil: "networkidle",
      timeout: opciones.timeout,
    });

    reporte.status = respuesta ? respuesta.status() : null;
    reporte.urlFinal = page.url();
    // Un redirect silencioso a /login es EL modo de fallo de este proyecto: se
    // audita una pantalla y en realidad se está mirando el login. Se marca.
    if (reporte.urlFinal !== urlObjetivo) {
      reporte.redirigido = true;
    }

    if (opciones.click) {
      try {
        await page.click(opciones.click, { timeout: 5000 });
        reporte.click = { selector: opciones.click, ok: true };
      } catch (err) {
        // No abortamos: el screenshot sigue siendo útil, pero hay que saber que
        // el clic no ocurrió (si no, se lee el shot como "el input no enfoca").
        reporte.click = {
          selector: opciones.click,
          ok: false,
          error: err.message.split("\n")[0],
        };
      }
    }

    if (opciones.keyboard > 0) {
      const { altoReducido, resizeDisparado } = await simularTeclado(
        page,
        perfil,
        opciones.keyboard,
      );
      reporte.teclado = {
        px: opciones.keyboard,
        alturaViewportResultante: altoReducido,
        resizeDisparado,
        nota: resizeDisparado
          ? "resize sintético emitido sobre window y visualViewport (isTrusted=false)."
          : "No hay window.visualViewport en esta página; solo se emitió resize en window.",
      };
    }

    if (opciones.wait > 0) {
      await page.waitForTimeout(opciones.wait);
    }

    await page.screenshot({ path: rutaSalida, fullPage: opciones.fullpage });

    reporte.layout = await medirLayout(page);
    reporte.png = rutaSalida;
    reporte.fullPage = opciones.fullpage;

    if (opciones.probePixels) {
      reporte.pixeles = await sondearPixeles(context, rutaSalida);
    }
  } finally {
    await context.close();
    await navegador.close();
    if (estatico) await estatico.cerrar();
  }

  // Primera línea: la ruta, para poder hacer `node shot.mjs ... | head -1`.
  console.log(rutaSalida);
  console.log(JSON.stringify(reporte, null, 2));
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
