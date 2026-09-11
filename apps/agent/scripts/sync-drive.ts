/**
 * CLI: sincroniza una carpeta de Google Drive (recursivo, resuelve shortcuts,
 * extrae texto de PDF/DOCX/XLSX y la indexa en drive_docs) para que quede
 * buscable por match_knowledge / search_knowledge.
 *
 * Reusable para CUALQUIER carpeta compartida con la service account de
 * GOOGLE_DRIVE_SA_KEY_PATH, no solo la que se indexó la primera vez.
 *
 * Uso: pnpm --filter @hermes/agent sync:drive -- <folder-id-o-url>
 */
import { syncDriveFolder, extractFolderId } from "../src/drive/sync.js";

const arg = process.argv[2];
if (!arg) {
  console.error("Uso: pnpm sync:drive -- <folder-id-o-url-de-drive>");
  process.exit(1);
}

const folderId = extractFolderId(arg);
if (!folderId) {
  console.error(`No pude extraer un folder ID de: "${arg}"`);
  process.exit(1);
}

console.log(`🔄 Sincronizando carpeta de Drive: ${folderId}\n`);
const result = await syncDriveFolder(folderId);

if (!result) {
  console.error(
    "✗ No se pudo sincronizar. Revisa GOOGLE_DRIVE_SA_KEY_PATH en .env, que la migración 030 esté aplicada, y que la carpeta esté compartida con la service account.",
  );
  process.exit(1);
}

console.log(
  `✅ ${result.indexed} indexados · ${result.scanned} escaneados · ${result.skipped} sin texto extraíble · ${result.removed} eliminados (ya no están en la carpeta)`,
);
