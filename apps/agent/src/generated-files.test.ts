/**
 * Tests del registro de archivos generados: pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  registerGeneratedFile,
  resolveGeneratedFile,
  _resetGeneratedFilesForTests,
} from "./generated-files.js";

// `pathAllowed` (guardrails.ts) exige que la ruta caiga dentro de
// VAULT_PATH/~/dev/~/Documents/~/server-os. Sin VAULT_PATH configurado en
// el entorno de test, usamos ~/dev (siempre en la lista) con un directorio
// temporal DENTRO de esa raíz — mkdtemp en /tmp cae FUERA a propósito, para
// el caso "ruta no permitida".
const DEV_ROOT = resolve(homedir(), "dev");

test.beforeEach(() => {
  _resetGeneratedFilesForTests();
});

test("registra un archivo real y devuelve un id opaco (nunca la ruta)", async () => {
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const path = join(dir, "informe.pdf");
    await writeFile(path, "contenido de prueba");
    const file = await registerGeneratedFile(path);
    assert.ok(file, "debió registrarse");
    assert.equal(file!.name, "informe.pdf");
    assert.equal(file!.mime, "application/pdf");
    assert.equal(file!.size, "contenido de prueba".length);
    assert.doesNotMatch(JSON.stringify(file), /generated-files-test-/, "el id no debe filtrar la ruta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveGeneratedFile devuelve la ruta real para un id válido", async () => {
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const path = join(dir, "datos.csv");
    await writeFile(path, "a,b,c");
    const file = await registerGeneratedFile(path);
    const resolved = await resolveGeneratedFile(file!.id);
    assert.ok(resolved);
    assert.equal(resolved!.path, path);
    assert.equal(resolved!.mime, "text/csv");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("un id que no existe (o vencido) devuelve null, no lanza", async () => {
  const resolved = await resolveGeneratedFile("00000000-0000-0000-0000-000000000000");
  assert.equal(resolved, null);
});

test("una ruta fuera de las raíces permitidas se rechaza en silencio (null, no excepción)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outside-allowed-"));
  try {
    const path = join(dir, "no-deberia-entrar.pdf");
    await writeFile(path, "x");
    const file = await registerGeneratedFile(path);
    assert.equal(file, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("una ruta que no existe en disco se rechaza en silencio", async () => {
  const file = await registerGeneratedFile(join(DEV_ROOT, "esto-no-existe-nunca.pdf"));
  assert.equal(file, null);
});

test("un directorio (no un archivo regular) se rechaza", async () => {
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const file = await registerGeneratedFile(dir);
    assert.equal(file, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registrar la MISMA ruta dos veces devuelve el MISMO id (no duplica la card)", async () => {
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const path = join(dir, "reporte.pdf");
    await writeFile(path, "v1");
    const first = await registerGeneratedFile(path);
    await writeFile(path, "v2 mas largo que v1");
    const second = await registerGeneratedFile(path);
    assert.equal(first!.id, second!.id);
    assert.equal(second!.size, "v2 mas largo que v1".length, "el tamaño se refresca");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registrar la MISMA ruta CONCURRENTEMENTE (sin esperar la primera) devuelve el MISMO id", async () => {
  // Hallazgo de auditoría adversaria (2026-09-17): antes del fix, dos
  // llamadas en paralelo para una ruta NUEVA podían pasar el `await stat` y
  // el dedup ANTES de que cualquiera terminara de registrar, creando dos
  // ids distintos para el mismo archivo (dos cards, dos auto-descargas del
  // mismo PDF en el cliente). `Promise.all` sin await intermedio es
  // justamente el escenario que dispara la interlazada si no está resuelto.
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const path = join(dir, "concurrente.pdf");
    await writeFile(path, "contenido");
    const [a, b, c] = await Promise.all([
      registerGeneratedFile(path),
      registerGeneratedFile(path),
      registerGeneratedFile(path),
    ]);
    assert.ok(a && b && c);
    assert.equal(a!.id, b!.id);
    assert.equal(b!.id, c!.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extensión desconocida cae a application/octet-stream", async () => {
  const dir = await mkdtemp(join(DEV_ROOT, "generated-files-test-"));
  try {
    const path = join(dir, "binario.xyz");
    await writeFile(path, "x");
    const file = await registerGeneratedFile(path);
    assert.equal(file!.mime, "application/octet-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
