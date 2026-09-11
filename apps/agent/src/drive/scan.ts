/**
 * Recorrido recursivo de una carpeta de Google Drive.
 *
 * Resuelve shortcuts inline (Drive los devuelve con `shortcutDetails` en el
 * mismo `list`, sin llamada extra) y sigue subcarpetas en BFS. Devuelve la
 * lista PLANA de archivos (sin carpetas) lista para descargar/indexar.
 */
import type { drive_v3 } from "@googleapis/drive";

export interface DriveFileEntry {
  /** ID real del archivo (si era shortcut, el del destino resuelto). */
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export async function listDriveFilesRecursive(
  drive: drive_v3.Drive,
  rootFolderId: string,
): Promise<DriveFileEntry[]> {
  const out: DriveFileEntry[] = [];
  const queue: string[] = [rootFolderId];
  const seenFolders = new Set<string>();

  while (queue.length) {
    const folderId = queue.shift()!;
    if (seenFolders.has(folderId)) continue;
    seenFolders.add(folderId);

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id,name,mimeType,webViewLink,shortcutDetails)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const f of res.data.files ?? []) {
        let { id, mimeType } = f;
        const { name, webViewLink } = f;

        if (mimeType === SHORTCUT_MIME) {
          const target = f.shortcutDetails;
          if (!target?.targetId) continue; // shortcut roto: se salta
          id = target.targetId;
          mimeType = target.targetMimeType ?? mimeType;
        }
        if (!id || !name || !mimeType) continue;

        if (mimeType === FOLDER_MIME) {
          queue.push(id);
          continue;
        }
        out.push({ id, name, mimeType, webViewLink: webViewLink ?? undefined });
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return out;
}

/** Acepta URL completa de Drive o un ID pelado; null si no reconoce nada. */
export function extractFolderId(input: string): string | null {
  const m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}
