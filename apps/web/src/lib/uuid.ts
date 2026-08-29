/**
 * UUID v4 que funciona TAMBIÉN fuera de un contexto seguro.
 *
 * `crypto.randomUUID()` solo existe en contextos seguros: HTTPS o localhost.
 * El dashboard se sirve por HTTP plano a una IP (LAN o Tailscale), que NO lo
 * es — ahí la función simplemente no está y la app moría con
 * "crypto.randomUUID is not a function" antes de pintar nada.
 *
 * Es un fallo silencioso en desarrollo (localhost sí es contexto seguro) que
 * solo aparece al abrir el dashboard desde otra máquina, que es justo el modo
 * multi-máquina para el que está pensado.
 *
 * `crypto.getRandomValues` sí está disponible sin contexto seguro, así que el
 * respaldo mantiene la aleatoriedad criptográfica; solo si tampoco existiera
 * se cae a Math.random, que para una clave de pestaña es suficiente.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);

  // Marcas de versión (4) y variante (10xx) que exige el formato v4.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
