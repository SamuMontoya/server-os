/**
 * Límites del plan de Claude Code, para los clientes que no son la web.
 *
 * POR QUÉ VIVE AQUÍ Y NO SE REUSA EL DE LA WEB
 * `apps/web/src/lib/claude-limits.ts` es código de servidor de Next y no es
 * importable desde el agente (son paquetes distintos). Moverlo a
 * `packages/shared` tampoco sirve: usa `fs` y `os`, y shared lo importa
 * también el cliente del navegador. Así que aquí va una versión MÍNIMA con lo
 * único que necesitan el reloj y el iPhone —porcentaje de la ventana de 5 h y
 * cuándo se reinicia—, no las cuatro ventanas semanales del panel.
 *
 * Los datos salen del endpoint privado `/api/oauth/usage` de Anthropic, que
 * exige un token OAuth vivo de la suscripción. NO se refresca aquí: el
 * endpoint de refresh rota el token y desloguearía a Claude Code. Se usa en
 * solo-lectura, con el token que ya hay en disco.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface Limites {
  /** 0-100, o null si no se pudo saber. */
  pct: number | null;
  /** ISO de cuándo se reinicia la ventana de 5 h. */
  resetsAt: string | null;
  /** Por qué no hay datos, para poder decirlo en vez de mentir con un 0. */
  error?: string;
}

/**
 * El token, en el mismo orden que la web.
 *
 * Sin Keychain: eso es de macOS y este agente corre en Linux. Intentarlo aquí
 * solo añadiría una rama muerta.
 */
async function token(): Promise<string | null> {
  if (process.env.CLAUDE_OAUTH_TOKEN) return process.env.CLAUDE_OAUTH_TOKEN;

  try {
    const t = (await readFile(join(homedir(), ".hermes-os", "claude-token"), "utf8")).trim();
    if (t) return t;
  } catch {
    /* no está: se prueba el siguiente */
  }
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return j.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

// Caché con TTL: el pie del chat lo pide en cada turno y este endpoint es de
// Anthropic, no nuestro. Sin caché se le pegaría un fetch por mensaje y el 429
// llega rápido.
const TTL_OK = 60_000;
const TTL_FALLO = 60_000;
const TTL_429 = 300_000;
let cache: { at: number; ttl: number; val: Limites } | null = null;

export async function limitesDelPlan(): Promise<Limites> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.val;

  const guardar = (val: Limites, ttl: number) => {
    cache = { at: Date.now(), ttl, val };
    return val;
  };

  const t = await token();
  if (!t) return guardar({ pct: null, resetsAt: null, error: "sin token" }, TTL_FALLO);

  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${t}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return guardar({ pct: null, resetsAt: null, error: "sin red" }, TTL_FALLO);
  }

  if (res.status === 401) {
    return guardar({ pct: null, resetsAt: null, error: "token caducado" }, TTL_FALLO);
  }
  if (res.status === 429) {
    return guardar({ pct: null, resetsAt: null, error: "demasiadas peticiones" }, TTL_429);
  }
  if (!res.ok) {
    return guardar({ pct: null, resetsAt: null, error: `HTTP ${res.status}` }, TTL_FALLO);
  }

  try {
    const j = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string };
    };
    const u = Number(j.five_hour?.utilization);
    return guardar(
      {
        // La API entrega 0-100; se acota por seguridad.
        pct: Number.isFinite(u) ? Math.max(0, Math.min(100, u)) : null,
        resetsAt: typeof j.five_hour?.resets_at === "string" ? j.five_hour.resets_at : null,
      },
      TTL_OK,
    );
  } catch {
    return guardar({ pct: null, resetsAt: null, error: "respuesta ilegible" }, TTL_FALLO);
  }
}
