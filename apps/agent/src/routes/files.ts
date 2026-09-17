import type { Hono } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveGeneratedFile } from "../generated-files.js";

/**
 * Descarga de archivos que el agente GENERÓ (Write/Bash) — ver
 * `generated-files.ts` para el registro id→ruta y el porqué de no exponer
 * la ruta absoluta. Autenticado por el middleware global de index.ts
 * (Bearer/JWT), igual que el resto del API — no es una ruta pública.
 *
 * OJO (auditoría adversaria, 2026-09-17): a diferencia de `/chat/turns/:id`
 * (que sí filtra por `turnVisibleTo`/`userId`, ver chat-turns.ts), esta ruta
 * NO cruza el id contra quién generó el archivo — cualquier request
 * autenticada que conozca el id (UUID v4, no adivinable) lo descarga, sin
 * importar qué usuario corrió el turno que lo creó. Riesgo aceptado por
 * ahora: `NEXT_PUBLIC_HERMES_ALLOWED_EMAILS` limita el acceso a un puñado
 * de cuentas de confianza (no es un SaaS multi-tenant), y el propio
 * middleware ya documenta que la barrera real de este sistema es la
 * autenticación, no un aislamiento por usuario dentro de ella. Si el
 * día de mañana entra una cuenta menos confiable a la allowlist, esto
 * necesita `userId` en `GeneratedFile`/`resolveGeneratedFile` igual que
 * `turnVisibleTo`.
 */
export function registerFilesRoutes(app: Hono): void {
  app.get("/files/download", async (c) => {
    const id = c.req.query("id") ?? "";
    if (!id) return c.json({ error: "id requerido" }, 400);
    const found = await resolveGeneratedFile(id);
    if (!found) return c.json({ error: "archivo no encontrado (¿id vencido o el archivo se borró?)" }, 404);
    const info = await stat(found.path).catch(() => null);
    if (!info) return c.json({ error: "el archivo ya no existe en disco" }, 404);

    // Content-Disposition con doble forma (ASCII + filename* UTF-8, RFC 5987):
    // un nombre con tildes/ñ en la forma simple corrompe algunos navegadores
    // viejos, pero omitir la forma simple rompe otros que no leen filename*.
    const asciiName = found.name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const utf8Name = encodeURIComponent(found.name);

    return new Response(Readable.toWeb(createReadStream(found.path)) as ReadableStream, {
      headers: {
        "Content-Type": found.mime,
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        // Cada id es un registro efímero en memoria (ver RETAIN_MS) que puede
        // apuntar a un archivo que YA CAMBIÓ (mismo id, contenido nuevo tras
        // un "regenera el PDF") — cachear sería servir una versión vieja.
        "Cache-Control": "private, no-store",
      },
    });
  });
}
