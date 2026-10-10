/**
 * Tests de extracción/verificación/empaquetado de imágenes sugeridas
 * (Épica B, buzón B5). `pnpm --filter @hermes/agent test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractImageUrls, verifyImageUrl, buildImageZip } from "./image-export.js";
import type { ChatTurn } from "../agent/chat-turns.js";

function mockTurn(text: string): ChatTurn {
  return {
    id: "img-test-0000-0000-0000-000000000000",
    sessionKey: "s1",
    project: "jaime-os",
    prompt: "sugiere imágenes",
    status: "done",
    text,
    steps: [],
    files: [],
    attempts: 1,
    startedAt: Date.now(),
  } as unknown as ChatTurn;
}

// ---------- extractImageUrls ----------

test("extractImageUrls: extrae markdown ![alt](url)", () => {
  const text = "Aquí va una imagen: ![diseño editorial](https://example.com/foto.jpg) para la diapositiva.";
  const out = extractImageUrls(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://example.com/foto.jpg");
  assert.equal(out[0].alt, "diseño editorial");
});

test("extractImageUrls: extrae URL suelta con extensión de imagen", () => {
  const text = "Mira esta referencia: https://cdn.example.com/banco/img123.png y úsala.";
  const out = extractImageUrls(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://cdn.example.com/banco/img123.png");
});

test("extractImageUrls: ignora URLs sueltas que NO son de imagen", () => {
  const text = "Revisa esta fuente: https://example.com/articulo-interesante y este PDF: https://example.com/doc.pdf";
  const out = extractImageUrls(text);
  assert.equal(out.length, 0);
});

test("extractImageUrls: deduplica la misma URL repetida", () => {
  const text = "![a](https://x.com/1.jpg) y de nuevo ![b](https://x.com/1.jpg)";
  const out = extractImageUrls(text);
  assert.equal(out.length, 1);
});

test("extractImageUrls: respeta el tope de 30 candidatas (adversarial: respuesta con 100 imágenes)", () => {
  const urls = Array.from({ length: 100 }, (_, i) => `![img${i}](https://x.com/${i}.jpg)`).join(" ");
  const out = extractImageUrls(urls);
  assert.equal(out.length, 30);
});

test("extractImageUrls: texto vacío no truena", () => {
  assert.deepEqual(extractImageUrls(""), []);
});

test("extractImageUrls: adversarial — URL con puntuación de cierre de frase no la incluye", () => {
  const text = "Esta es la imagen: https://example.com/foto.jpg. Úsala con cuidado.";
  const out = extractImageUrls(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://example.com/foto.jpg");
});

// ---------- verifyImageUrl (mockeando fetch) ----------

test("verifyImageUrl: URL que responde 200 + content-type image/* se marca ok", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () =>
    new Response(null, { status: 200, headers: { "content-type": "image/jpeg", "content-length": "1024" } });

  const out = await verifyImageUrl({ url: "https://x.com/foto.jpg" });
  assert.equal(out.ok, true);
  assert.equal(out.contentType, "image/jpeg");
});

test("verifyImageUrl: 404 (imagen alucinada/borrada) se marca no-ok con el motivo", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response(null, { status: 404 });

  const out = await verifyImageUrl({ url: "https://x.com/no-existe.jpg" });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /404/);
});

test("verifyImageUrl: content-type que NO es imagen (ej. una página HTML) se rechaza", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () =>
    new Response(null, { status: 200, headers: { "content-type": "text/html" } });

  const out = await verifyImageUrl({ url: "https://x.com/pagina.jpg" });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /no es una imagen/);
});

test("verifyImageUrl: imagen demasiado pesada (>15MB) se rechaza", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () =>
    new Response(null, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(20 * 1024 * 1024) },
    });

  const out = await verifyImageUrl({ url: "https://x.com/gigante.png" });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /pesada/);
});

test("verifyImageUrl: adversarial — HEAD falla (405) pero GET funciona: fallback exitoso", async () => {
  let llamadas = 0;
  (globalThis as { fetch: typeof fetch }).fetch = async (_url: any, init?: any) => {
    llamadas++;
    if (init?.method === "HEAD") return new Response(null, { status: 405 });
    return new Response(null, { status: 200, headers: { "content-type": "image/png" } });
  };

  const out = await verifyImageUrl({ url: "https://x.com/necesita-get.png" });
  assert.equal(out.ok, true);
  assert.equal(llamadas, 2, "debe intentar HEAD primero y caer a GET");
});

test("verifyImageUrl: adversarial — fetch arroja (red caída) no truena, marca error", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => {
    throw new TypeError("network error (prueba)");
  };

  const out = await verifyImageUrl({ url: "https://x.com/caida.png" });
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

// ---------- buildImageZip (integración) ----------

test("buildImageZip: respuesta sin imágenes produce un zip solo con reporte.md", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response(null, { status: 404 });

  const turn = mockTurn("No hay imágenes en esta respuesta, solo texto.");
  const { stream, report } = await buildImageZip(turn);

  assert.equal(report.total, 0);
  assert.equal(report.empaquetadas, 0);
  // Confirmar que el stream produce bytes (un zip válido, aunque sea solo con reporte.md)
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const buf = Buffer.concat(chunks);
  assert.ok(buf.length > 0);
  assert.equal(buf[0], 0x50); // firma ZIP "PK"
  assert.equal(buf[1], 0x4b);
});

test("buildImageZip: imagen verificada se empaqueta, imagen alucinada queda en el reporte (adversarial real de B5)", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = async (url: any) => {
    const u = String(url);
    if (u.includes("real")) {
      return new Response(Buffer.from("fake-jpg-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "14" },
      });
    }
    // La "alucinada": el modelo la inventó, no existe de verdad.
    return new Response(null, { status: 404 });
  };

  const turn = mockTurn(
    "![real](https://x.com/real.jpg) y también ![inventada](https://x.com/inventada-por-el-modelo.jpg)",
  );
  const { stream, report } = await buildImageZip(turn);

  assert.equal(report.total, 2);
  assert.equal(report.empaquetadas, 1);
  assert.equal(report.descartadas.length, 1);
  assert.match(report.descartadas[0].url, /inventada/);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  assert.ok(Buffer.concat(chunks).length > 0);
});
