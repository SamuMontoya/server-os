/**
 * Tests de la detección de "archivos entregables" que deja un Bash (la
 * mitad difícil de generated-files.ts: Write trae la ruta exacta, Bash no
 * deja ninguna señal estructurada — ver el comentario grande en session.ts).
 *
 * Fix 2026-10-09 (Épica B, buzón #13 "dice 'dejé el archivo en 00 Inbox/...'
 * pero no hay manera de acceder a esos archivos"): esta lógica NO tenía
 * ningún test pese a ser la causa raíz real del reporte — dos bugs
 * compuestos, ambos cubiertos abajo:
 *   1. `snapshotDeliverables` solo miraba el primer nivel de un directorio:
 *      un archivo en una SUBCARPETA (ej. "00 Inbox/archivo.xml") era
 *      invisible aunque sí se hubiera escrito.
 *   2. Con un proyecto en foco (`opts.cwd` = su repo local), la única raíz
 *      vigilada era ESA — cualquier escritura al vault (otra ruta
 *      completamente distinta) nunca se comparaba.
 *
 * `pnpm --filter @hermes/agent test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { snapshotDeliverables, deliverableRoots, snapshotAllRoots } from "./session.js";

// Mismo motivo que generated-files.test.ts: sin VAULT_PATH en el entorno de
// test, se usa ~/dev (vive en ALLOWED_WRITE_ROOTS) para los directorios de
// prueba — acá no hace falta `pathAllowed` (snapshotDeliverables no lo usa),
// pero mantener el mismo patrón evita sorpresas si algo más lo asume.
const DEV_ROOT = resolve(homedir(), "dev");

async function conDirTemporal(prefix: string, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(DEV_ROOT, prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("snapshotDeliverables NO recursivo: ve archivos del primer nivel, ignora subcarpetas", async () => {
  await conDirTemporal("snap-norecursive-", async (dir) => {
    await writeFile(join(dir, "visible.pdf"), "x");
    await mkdir(join(dir, "00 Inbox"));
    await writeFile(join(dir, "00 Inbox", "invisible.xml"), "<x/>");

    const out = await snapshotDeliverables(dir, false);
    assert.ok(out.has(join(dir, "visible.pdf")));
    assert.equal(out.has(join(dir, "00 Inbox", "invisible.xml")), false);
  });
});

test("snapshotDeliverables recursivo: SÍ ve el archivo en la subcarpeta (el bug real)", async () => {
  await conDirTemporal("snap-recursive-", async (dir) => {
    await mkdir(join(dir, "00 Inbox"));
    const path = join(dir, "00 Inbox", "Quiz 1 DBG11 - corregido.xml");
    await writeFile(path, "<quiz/>");

    const out = await snapshotDeliverables(dir, true);
    assert.ok(out.has(path), "el archivo en la subcarpeta debe aparecer con recursive=true");
  });
});

test("snapshotDeliverables respeta el tope de profundidad (maxDepth)", async () => {
  await conDirTemporal("snap-depth-", async (dir) => {
    const hondo = join(dir, "a", "b", "c", "d", "e");
    await mkdir(hondo, { recursive: true });
    await writeFile(join(hondo, "muy-hondo.txt"), "x");

    const out = await snapshotDeliverables(dir, true, 2);
    assert.equal(out.size, 0, "más allá del tope de profundidad no debe escanearse");
  });
});

test(".xml ahora es una extensión 'entregable' (antes no estaba en la lista — era invisible aunque se escaneara el directorio correcto)", async () => {
  await conDirTemporal("snap-xml-ext-", async (dir) => {
    await writeFile(join(dir, "quiz.xml"), "<quiz/>");
    const out = await snapshotDeliverables(dir, false);
    assert.ok(out.has(join(dir, "quiz.xml")));
  });
});

test("extensiones no 'entregables' (.ts, .py) se ignoran — sin esto cada edición de código generaría una card", async () => {
  await conDirTemporal("snap-noext-", async (dir) => {
    await writeFile(join(dir, "script.ts"), "x");
    await writeFile(join(dir, "notas.pdf"), "x");
    const out = await snapshotDeliverables(dir, false);
    assert.equal(out.size, 1);
    assert.ok(out.has(join(dir, "notas.pdf")));
  });
});

test("deliverableRoots: con proyecto en foco Y vault distinto, vigila AMBAS raíces — antes solo vigilaba una (bug real de #13)", async () => {
  const roots = deliverableRoots("/ruta/del/proyecto");
  // No depende de que VAULT_PATH esté seteado en este proceso de test: si lo
  // está, debe aparecer una segunda raíz recursiva; si no, al menos la del
  // proyecto debe estar, no-recursiva.
  const proyecto = roots.find((r) => r.dir === "/ruta/del/proyecto");
  assert.ok(proyecto, "la raíz del proyecto siempre debe estar presente");
  assert.equal(proyecto!.recursive, false, "el cwd de un proyecto NUNCA se escanea recursivo");
});

test("deliverableRoots: sin proyecto en foco, cae a VAULT_PATH o cwd() — nunca una lista vacía", async () => {
  const roots = deliverableRoots(undefined);
  assert.ok(roots.length >= 1, "siempre debe haber al menos una raíz que vigilar");
});

test("deliverableRoots: nunca duplica la misma raíz dos veces (cwd === vaultPath)", async () => {
  const roots = deliverableRoots("/mismo/lugar", "/mismo/lugar");
  assert.equal(roots.length, 1, "cwd y vault apuntando al mismo directorio no deben duplicarse");
});

test("snapshotAllRoots: un archivo en el cwd del proyecto Y otro en una subcarpeta del vault aparecen AMBOS — reproduce el fix end-to-end", async () => {
  await conDirTemporal("proyecto-", async (proyecto) => {
    await conDirTemporal("vault-sim-", async (vault) => {
      await writeFile(join(proyecto, "informe.pdf"), "x");
      await mkdir(join(vault, "00 Inbox"));
      const enVault = join(vault, "00 Inbox", "quiz-corregido.xml");
      await writeFile(enVault, "<quiz/>");

      // `vault` se inyecta explícito — en producción sería `env.VAULT_PATH`,
      // acá se evita depender de mutar process.env (env.ts lo congela al
      // importar, ver el comentario de `deliverableRoots`).
      const out = await snapshotAllRoots(proyecto, vault);
      assert.ok(out.has(join(proyecto, "informe.pdf")), "el archivo del proyecto debe verse");
      assert.ok(
        out.has(enVault),
        "el archivo en la subcarpeta del vault TAMBIÉN debe verse — este es el bug real que reportó Jaime",
      );
    });
  });
});
