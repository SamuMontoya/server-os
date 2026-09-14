import { defineConfig, devices } from "@playwright/test";

/**
 * Config mínima para el audit visual del Orbe IA (WebGL) contra varios
 * motores/navegadores reales: no todo el resto de la app tiene tests e2e
 * todavía, esto es deliberadamente angosto — ver orbe.spec.ts.
 *
 * Puerto de prueba DISTINTO del real (31415, el que usa hermes-web en
 * producción): un `next build && next start` propio, dedicado a los tests,
 * para no pisar ni reiniciar el servicio real mientras alguien lo esté
 * usando. `NEXT_PUBLIC_WEB_PORT_TEST` permite apuntar a una instancia ya
 * levantada a mano (más rápido en iteración local) — con
 * `reuseExistingServer:true`, si ya hay algo sirviendo en ese puerto, se
 * reusa tal cual en vez de reconstruir.
 */
const PUERTO_TEST = Number(process.env.NEXT_PUBLIC_WEB_PORT_TEST || 31417);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  // Autentica una sesión real de Supabase (sin pasar por el botón de Google)
  // antes de correr nada — /orbe está detrás del middleware de auth. Ver
  // e2e/global-setup.ts.
  globalSetup: require.resolve("./e2e/global-setup.ts"),
  webServer: {
    command: `NEXT_PUBLIC_WEB_PORT=${PUERTO_TEST} pnpm build && NEXT_PUBLIC_WEB_PORT=${PUERTO_TEST} pnpm start`,
    port: PUERTO_TEST,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  use: {
    baseURL: `http://localhost:${PUERTO_TEST}`,
    storageState: "e2e/.auth/session.json",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "msedge", use: { ...devices["Desktop Edge"], channel: "msedge" } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
