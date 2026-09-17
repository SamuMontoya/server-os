import { homedir } from "node:os";
import { resolve } from "node:path";
import { env } from "../env.js";

/**
 * Guardrail canUseTool: las tareas disparadas por voz/chat corren SIN humano
 * en el loop, así que esto es la última línea de defensa.
 *
 * - Bash: deny-list de comandos destructivos.
 * - Write/Edit: solo dentro del vault, ~/dev, ~/Documents y el repo server-os.
 */
const DENY_PATTERNS: RegExp[] = [
  // rm recursivo + forzado: bundled (-rf/-fr), flags separados (-r -f) o
  // largos (--recursive --force), en cualquier orden/combinación. La versión
  // anterior solo cazaba el bundle de un solo token (-rf/-fr) — un
  // auto-ataque encontró que `rm -r -f /` y `rm --recursive --force /`
  // pasaban derecho porque el regex exigía las dos letras juntas en el MISMO
  // flag.
  /\brm\b(?=.*(?:^|\s)(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)(?:\s|$))(?=.*(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?:\s|$))/i,
  /\bsudo\b/i,
  // git push forzado: --force o su forma corta -f (el regex viejo solo
  // cazaba --force; `git push -f` — la que de verdad usa la gente — pasaba
  // derecho). El [^\n]* limita a la MISMA línea, no a todo lo que viene
  // después en la cadena (evita falsos positivos en logs/documentación).
  /\bgit\s+push\b[^\n]*(?:-f\b|--force\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bmkfs\b|\bdiskutil\s+erase/i,
  /\bshutdown\b|\breboot\b/i,
  /:\s*\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bchmod\s+-R\s+777\s+\//,
  />\s*\/dev\/sd[a-z]/,
  // pipe a shell: curl Y wget (el regex viejo solo cazaba curl).
  /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
  /\bdrop\s+(table|database)\b/i,
];

const HOME = homedir();
const ALLOWED_WRITE_ROOTS = [
  env.VAULT_PATH,
  resolve(HOME, "dev"),
  resolve(HOME, "Documents"),
  resolve(HOME, "server-os"),
].filter(Boolean);

/**
 * Exportada (además de usarse acá dentro) para `generated-files.ts`: la
 * detección de archivos generados necesita el MISMO criterio de "ruta
 * confiable" que ya gobierna qué puede escribir Write/Edit — no un segundo
 * criterio que pueda divergir con el tiempo.
 */
export function pathAllowed(p: string): boolean {
  const abs = resolve(p.startsWith("~") ? p.replace("~", HOME) : p);
  return ALLOWED_WRITE_ROOTS.some((root) => abs.startsWith(root + "/") || abs === root);
}

export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkTool(
  toolName: string,
  input: Record<string, unknown>,
): GuardrailVerdict {
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    for (const pattern of DENY_PATTERNS) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Comando bloqueado por guardrail (patrón peligroso): ${pattern}`,
        };
      }
    }
    return { allowed: true };
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (filePath && !pathAllowed(filePath)) {
      return {
        allowed: false,
        reason: `Escritura fuera de las rutas permitidas (${ALLOWED_WRITE_ROOTS.join(", ")}): ${filePath}`,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}
