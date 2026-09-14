/**
 * Tests de `extractText` para el parser de EPUB (extractEpubText, interno).
 * Construye un EPUB mínimo válido en memoria con jszip — mismo patrón que un
 * lector real: META-INF/container.xml -> .opf (manifest + spine) -> XHTML.
 * No depende de un archivo .epub externo en el repo.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractText } from "./extract.js";

async function buildEpub(opts: {
  opfPath?: string;
  chapters: { id: string; href: string; html: string }[];
  spineOrder?: string[];
}): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const opfPath = opts.opfPath ?? "OEBPS/content.opf";
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );

  const manifestItems = opts.chapters
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const spineIds = opts.spineOrder ?? opts.chapters.map((c) => c.id);
  const spineItems = spineIds.map((id) => `<itemref idref="${id}"/>`).join("\n");

  zip.file(
    opfPath,
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>${manifestItems}</manifest>
  <spine>${spineItems}</spine>
</package>`,
  );

  for (const c of opts.chapters) {
    zip.file(opfDir + c.href, c.html);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

test("EPUB: extrae texto de los capítulos en el orden del spine", async () => {
  const buf = await buildEpub({
    chapters: [
      { id: "ch2", href: "text/ch2.xhtml", html: "<html><body><p>Segundo capítulo</p></body></html>" },
      { id: "ch1", href: "text/ch1.xhtml", html: "<html><body><p>Primer capítulo</p></body></html>" },
    ],
    spineOrder: ["ch1", "ch2"], // el orden de lectura manda, no el orden del manifest
  });

  const text = await extractText(buf, "application/epub+zip", "libro.epub");
  assert.ok(text.indexOf("Primer capítulo") < text.indexOf("Segundo capítulo"));
});

test("EPUB: limpia tags HTML y decodifica entidades básicas", async () => {
  const buf = await buildEpub({
    chapters: [
      {
        id: "ch1",
        href: "ch1.xhtml",
        html: "<html><body><h1>Título</h1><p>Uno &amp; dos &mdash; <b>tres</b></p><script>ignorar()</script></body></html>",
      },
    ],
  });

  const text = await extractText(buf, "application/epub+zip", "libro.epub");
  assert.match(text, /Título/);
  assert.match(text, /Uno & dos/);
  assert.match(text, /tres/);
  assert.doesNotMatch(text, /<[a-z]/i);
  assert.doesNotMatch(text, /ignorar\(\)/);
});

test("EPUB: reconoce por extensión aunque el mimeType venga vacío (caso típico de navegador)", async () => {
  const buf = await buildEpub({
    chapters: [{ id: "ch1", href: "ch1.xhtml", html: "<p>contenido detectado por extensión</p>" }],
  });

  const text = await extractText(buf, "", "cuento.epub");
  assert.match(text, /contenido detectado por extensión/);
});

test("EPUB: resuelve el .opf aunque no esté en OEBPS/ (ruta arbitraria vía container.xml)", async () => {
  const buf = await buildEpub({
    opfPath: "content/book.opf",
    chapters: [{ id: "ch1", href: "chapters/uno.xhtml", html: "<p>capítulo en ruta no estándar</p>" }],
  });

  const text = await extractText(buf, "application/epub+zip", "libro.epub");
  assert.match(text, /capítulo en ruta no estándar/);
});

test("EPUB: archivo corrupto/sin container.xml devuelve string vacío en vez de lanzar", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  const text = await extractText(buf, "application/epub+zip", "roto.epub");
  assert.equal(text, "");
});
