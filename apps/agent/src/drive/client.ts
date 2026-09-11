/**
 * Cliente de Google Drive API vía cuenta de servicio.
 *
 * GOOGLE_DRIVE_SA_KEY_PATH apunta al JSON de la service account (fuera del
 * repo, nunca se commitea). Sin esa variable, la tool/CLI de Drive queda
 * inactiva y lo dice claro en vez de fallar oscuro más adelante.
 */
import { readFile } from "node:fs/promises";
import { drive, type drive_v3 } from "@googleapis/drive";
import { GoogleAuth } from "google-auth-library";
import { env } from "../env.js";

// Paquete scoped (no el meta-paquete `googleapis`, cuyos types de las ~200
// APIs de Google se comen la RAM de tsc en un servidor con 4GB).
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

let cached: drive_v3.Drive | null = null;

export async function getDriveClient(): Promise<drive_v3.Drive | null> {
  if (cached) return cached;
  if (!env.GOOGLE_DRIVE_SA_KEY_PATH) return null;

  let credentials: object;
  try {
    credentials = JSON.parse(await readFile(env.GOOGLE_DRIVE_SA_KEY_PATH, "utf8"));
  } catch (err) {
    console.error(`[drive] no pude leer GOOGLE_DRIVE_SA_KEY_PATH (${env.GOOGLE_DRIVE_SA_KEY_PATH}):`, err);
    return null;
  }

  const auth = new GoogleAuth({ credentials, scopes: SCOPES });
  cached = drive({ version: "v3", auth });
  return cached;
}
