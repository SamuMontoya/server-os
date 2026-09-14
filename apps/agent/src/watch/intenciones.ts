/**
 * TERCERA velocidad del canal del reloj: intenciones directas.
 *
 * Hay peticiones que no necesitan ni charla ni un turno completo, porque son
 * UNA escritura. Capturar una idea es el caso claro: escalar a un turno con
 * tools cuesta ~28 s por algo que aquí tarda lo que tarde la base de datos.
 *
 * El modelo las marca con un centinela y esto las resuelve. Mismo patrón que
 * `IMAGEN:`, y por el mismo motivo.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env.js";
import { saveMemory } from "../memory.js";

export const CENTINELA_IDEA = "IDEA:";

/**
 * Guarda una idea suelta.
 *
 * La memoria es lo que importa y es lo que siempre se hace. El archivo en
 * `00 Inbox/` del vault es un extra que solo ocurre si esta máquina TIENE
 * vault (`VAULT_PATH` seteado). `docs/multi-maquina.md` describe una
 * arquitectura vieja (Mac mini como dueña del vault + PCs "solo ejecución");
 * ya no aplica — jaime-srv es la única máquina y desde 2026-09-11 es también
 * la dueña del vault (`/root/vault`). Si en el futuro vuelve a haber más de
 * una máquina, la que NO tenga vault debe dejar `VAULT_PATH` vacío: sin este
 * guard, `join("", "00 Inbox")` da una ruta RELATIVA que Node resuelve
 * contra el cwd del proceso — "00 Inbox" fantasma dentro del propio repo.
 */
export async function capturarIdea(texto: string): Promise<boolean> {
  const contenido = texto.trim();
  if (!contenido) return false;

  try {
    await saveMemory({
      content: contenido,
      type: "agent",
      tags: ["idea", "reloj"],
      source: "agent",
    });
  } catch (err) {
    console.error("[reloj] no se pudo guardar la idea:", err);
    return false;
  }

  if (env.VAULT_PATH) {
    try {
      const inbox = join(env.VAULT_PATH, "00 Inbox");
      await mkdir(inbox, { recursive: true });
      const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      await appendFile(
        join(inbox, `idea-${sello}.md`),
        `---\ncapturada: ${new Date().toISOString()}\ntags: [idea, reloj]\norigen: reloj\n---\n\n${contenido}\n`,
      );
    } catch (err) {
      // El vault es el extra: si falla, la idea ya está a salvo en la memoria.
      console.error("[reloj] idea guardada en memoria pero no en el vault:", err);
    }
  }
  return true;
}
