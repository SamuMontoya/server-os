#!/usr/bin/env node
/**
 * fetch-fonts.mjs · descarga las fuentes a src/app/fonts/ para auto-hospedarlas.
 *
 * Por qué existe:
 *   `next/font/google` descarga las fuentes de fonts.gstatic.com EN CADA BUILD.
 *   En esta caja la conexión es intermitente, y cuando falla Next entra en un
 *   bucle "Retrying 1/3..." que deja el build colgado hasta el timeout. Es la
 *   causa real de los builds "Failed" y de los que se quedan pensando 15 min.
 *
 *   Con las fuentes en disco usamos `next/font/local` y el build deja de tocar
 *   la red por completo: mismo resultado visual, cero dependencia de internet.
 *
 * Este script NO corre en el prebuild a propósito: se ejecuta a mano, y solo
 * cuando cambien las familias o los pesos de layout.tsx.
 *
 *   node scripts/fetch-fonts.mjs
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/app/fonts");

// Debe coincidir con lo que layout.tsx declara. Si añades un peso allí,
// añádelo aquí y vuelve a correr el script.
const FAMILIAS = [
  { query: "Chakra+Petch:wght@400;600;700", pesos: [400, 600, 700], slug: "chakra-petch" },
  { query: "IBM+Plex+Mono:wght@400;500;600", pesos: [400, 500, 600], slug: "ibm-plex-mono" },
];

const SUBSET = "latin";
// Sin un UA de navegador moderno, Google sirve .ttf en vez de .woff2.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function conReintentos(url, opts = {}, intentos = 3) {
  let ultimoError;
  for (let i = 1; i <= intentos; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      ultimoError = e;
      console.warn(`  reintento ${i}/${intentos} · ${url.slice(0, 60)}… (${e.message})`);
      if (i < intentos) await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  throw new Error(`no se pudo descargar ${url}: ${ultimoError?.message}`);
}

/**
 * El CSS de Google trae un @font-face por subset (latin, latin-ext, vietnamese…),
 * cada uno precedido de un comentario con el nombre del subset. Nos quedamos
 * solo con el bloque `latin` de cada peso pedido.
 */
function extraerLatin(css, pesos) {
  const encontrados = new Map();
  const bloques = css.split("/*").slice(1);
  for (const bloque of bloques) {
    const subset = bloque.slice(0, bloque.indexOf("*/")).trim();
    if (subset !== SUBSET) continue;
    const peso = Number(bloque.match(/font-weight:\s*(\d+)/)?.[1]);
    const url = bloque.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    if (url && pesos.includes(peso) && !encontrados.has(peso)) encontrados.set(peso, url);
  }
  return encontrados;
}

await mkdir(DIR, { recursive: true });
let total = 0;

for (const { query, pesos, slug } of FAMILIAS) {
  console.log(`[fonts] ${slug}`);
  const css = await (
    await conReintentos(`https://fonts.googleapis.com/css2?family=${query}&display=swap`, {
      headers: { "User-Agent": UA },
    })
  ).text();

  const urls = extraerLatin(css, pesos);
  const faltan = pesos.filter((p) => !urls.has(p));
  if (faltan.length) throw new Error(`${slug}: no encontré el subset ${SUBSET} para ${faltan.join(", ")}`);

  for (const [peso, url] of urls) {
    const buf = Buffer.from(await (await conReintentos(url, { headers: { "User-Agent": UA } })).arrayBuffer());
    const archivo = `${slug}-${peso}.woff2`;
    await writeFile(resolve(DIR, archivo), buf);
    console.log(`  ✓ ${archivo} (${(buf.length / 1024).toFixed(1)} KB)`);
    total++;
  }
}

console.log(`[fonts] ${total} archivos en src/app/fonts/`);
console.log("[fonts] recuerda: layout.tsx debe usar next/font/local apuntando aquí.");
console.log(`[fonts] contenido: ${(await readdir(DIR)).join(", ")}`);
