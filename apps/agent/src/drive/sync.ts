/**
 * Sincroniza CUALQUIER carpeta de Google Drive a la tabla drive_docs
 * (migración 030), reusable desde la tool `sync_drive_folder` o desde
 * `scripts/sync-drive.ts` (CLI).
 *
 * Idempotente por hash (igual patrón que vault_docs / knowledge-sync.ts):
 * solo se descarga/re-embebe lo que cambió desde el último sync. Los
 * archivos que ya no están en la carpeta (borrados/movidos) se eliminan del
 * índice, acotado a `source_folder_id` para no tocar docs de otras carpetas.
 */
import { createHash } from "node:crypto";
import { getDriveClient } from "./client.js";
import { listDriveFilesRecursive, type DriveFileEntry } from "./scan.js";
import { extractText } from "./extract.js";
import { supabase } from "../supabase.js";
import { embedBatch, EMB } from "../embeddings.js";

export { extractFolderId } from "./scan.js";

const MAX_CONTENT_CHARS = 16_000;

/** Docs nativos de Google (Docs/Sheets/Slides) no tienen bytes descargables: hay que exportarlos. */
const EXPORT_MIME: Record<string, { mime: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
};

export interface DriveSyncResult {
  scanned: number;
  indexed: number;
  removed: number;
  skipped: number;
}

interface ChangedDoc {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  content: string;
  hash: string;
}

async function downloadAndExtract(
  drive: NonNullable<Awaited<ReturnType<typeof getDriveClient>>>,
  f: DriveFileEntry,
): Promise<string | null> {
  const exportInfo = EXPORT_MIME[f.mimeType];
  let buf: Buffer;
  let mimeForExtract = f.mimeType;

  try {
    if (exportInfo) {
      const res = await drive.files.export(
        { fileId: f.id, mimeType: exportInfo.mime },
        { responseType: "arraybuffer" },
      );
      buf = Buffer.from(res.data as ArrayBuffer);
      mimeForExtract = exportInfo.mime;
    } else {
      const res = await drive.files.get({ fileId: f.id, alt: "media" }, { responseType: "arraybuffer" });
      buf = Buffer.from(res.data as ArrayBuffer);
    }
  } catch (err) {
    console.error(`[drive] descarga falló (${f.name}):`, (err as Error).message);
    return null;
  }

  return extractText(buf, mimeForExtract, f.name);
}

export async function syncDriveFolder(folderId: string): Promise<DriveSyncResult | null> {
  const drive = await getDriveClient();
  if (!drive) {
    console.error("[drive] sin cliente (falta GOOGLE_DRIVE_SA_KEY_PATH o key inválida).");
    return null;
  }
  if (!supabase) {
    console.error("[drive] Supabase no configurado.");
    return null;
  }

  const files = await listDriveFilesRecursive(drive, folderId);

  // Hashes ya indexados PARA ESTA carpeta (paginado, igual que vault_docs).
  const known = new Map<string, string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("drive_docs")
        .select("drive_file_id,content_hash")
        .eq("source_folder_id", folderId)
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("[drive] no pude leer drive_docs — ¿corriste la migración 030?", error.message);
        return null;
      }
      if (!data?.length) break;
      for (const r of data) known.set(r.drive_file_id as string, r.content_hash as string);
      if (data.length < PAGE) break;
    }
  }

  const seen = new Set<string>();
  const changed: ChangedDoc[] = [];
  let skipped = 0;

  for (const f of files) {
    seen.add(f.id);
    const text = await downloadAndExtract(drive, f);
    if (text === null) {
      skipped++;
      continue;
    }
    const content = text.trim().slice(0, MAX_CONTENT_CHARS);
    if (!content) {
      skipped++;
      continue;
    }
    const hash = createHash("sha1").update(content).digest("hex");
    if (known.get(f.id) === hash) continue; // sin cambios desde el último sync

    changed.push({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink, content, hash });
  }

  let indexed = 0;
  const BATCH = 10;
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    const vectors = await embedBatch(batch.map((d) => `${d.name}\n${d.content}`));
    const rows = batch.map((d, j) => ({
      drive_file_id: d.id,
      name: d.name,
      mime_type: d.mimeType,
      web_view_link: d.webViewLink ?? null,
      content: d.content,
      content_hash: d.hash,
      source_folder_id: folderId,
      [EMB.col]: vectors[j],
      synced_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from("drive_docs").upsert(rows, { onConflict: "drive_file_id" });
    if (error) {
      console.error("[drive] upsert falló:", error.message);
      continue;
    }
    indexed += rows.length;
  }

  // Limpieza acotada a esta carpeta: lo que ya no aparece, se borra del índice.
  const staleIds = [...known.keys()].filter((id) => !seen.has(id));
  let removed = 0;
  if (staleIds.length) {
    const { error } = await supabase.from("drive_docs").delete().in("drive_file_id", staleIds);
    if (!error) removed = staleIds.length;
  }

  return { scanned: files.length, indexed, removed, skipped };
}
