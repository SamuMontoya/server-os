import { config } from "dotenv";
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Identidad del DUEÑO de esta instancia de OS. Todo lo que el agente
 * sabe "de quién es" sale de aquí — nunca del código — para que el mismo
 * repo corra en la máquina de cualquiera sin cruzar configuraciones:
 *
 *   - HERMES_OWNER_NAME: nombre con el que OS se dirige a su dueño
 *     (default: el usuario del sistema, capitalizado).
 *   - SOUL.md (~/.hermes-os/SOUL.md, override HERMES_SOUL_PATH): persona
 *     y preferencias en markdown libre, inyectadas completas al system
 *     prompt del agente. Vive FUERA del repo: es dato personal, no código.
 *     Plantilla en docs/SOUL.example.md.
 */

// Mismo .env de la raíz que env.ts (dotenv no pisa variables ya definidas):
// este módulo puede importarse antes que env.ts y debe ver HERMES_OWNER_NAME.
config({ path: resolve(fileURLToPath(import.meta.url), "../../../..", ".env") });

function systemUserName(): string {
  try {
    const u = userInfo().username || "";
    return u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
  } catch {
    return "";
  }
}

export const OWNER: string = process.env.HERMES_OWNER_NAME?.trim() || systemUserName() || "Usuario";

export const SOUL_PATH: string = process.env.HERMES_SOUL_PATH || join(homedir(), ".hermes-os", "SOUL.md");

const SOUL_MAX_CHARS = 6000;
let cache: { mtimeMs: number; text: string } | null = null;

/** Contenido de SOUL.md (cacheado por mtime; "" si no existe). */
export function readSoul(): string {
  try {
    const { mtimeMs } = statSync(SOUL_PATH);
    if (cache && cache.mtimeMs === mtimeMs) return cache.text;
    const text = readFileSync(SOUL_PATH, "utf8").trim().slice(0, SOUL_MAX_CHARS);
    cache = { mtimeMs, text };
    return text;
  } catch {
    cache = null;
    return "";
  }
}

/** Bloque listo para un system prompt: "# Sobre <dueño>\n<SOUL.md>" ("" si no hay SOUL). */
export function soulPromptBlock(): string {
  const soul = readSoul();
  return soul ? `# Sobre ${OWNER} (SOUL.md)\n${soul}` : "";
}
