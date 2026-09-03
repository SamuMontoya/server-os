/**
 * Límites del plan de Claude Code, para los clientes que no son la web
 * (reloj, iPhone): porcentaje de la ventana de 5 h y cuándo se reinicia,
 * nada más — no las cuatro ventanas semanales del panel completo.
 *
 * Delega en claude-limits.ts (mismo paquete, mismo caché/TTL/credencial):
 * antes esto duplicaba token()+fetch() a mano porque claude-limits.ts vivía
 * en apps/web (Next.js, no importable desde el agente); ahora que también
 * vive aquí no hay razón para mantener una segunda copia del mismo fetch al
 * endpoint de Anthropic, que ya rate-limita agresivo de por sí.
 */
import { getClaudeLimits } from "./claude-limits.js";

export interface Limites {
  /** 0-100, o null si no se pudo saber. */
  pct: number | null;
  /** ISO de cuándo se reinicia la ventana de 5 h. */
  resetsAt: string | null;
  /** Por qué no hay datos, para poder decirlo en vez de mentir con un 0. */
  error?: string;
}

export async function limitesDelPlan(): Promise<Limites> {
  const full = await getClaudeLimits();
  if (!full.available || !full.session) {
    return { pct: null, resetsAt: null, error: full.reason ?? "sin datos" };
  }
  return { pct: full.session.utilization, resetsAt: full.session.resetsAt };
}
