import type { MetadataRoute } from "next";

/**
 * Manifest de la app instalable. Next lo sirve en /manifest.webmanifest.
 *
 * No es cosmético: sin manifest, "Añadir a pantalla de inicio" en iOS deja un
 * marcador de Safari —con su barra, y con el ciclo de vida de una pestaña
 * cualquiera—. Con `display: standalone` el sistema lo trata como app: se abre
 * sin barra y conserva mejor el estado al cambiar de app.
 *
 * Aun así iOS acaba matando la pestaña en segundo plano, y por eso el hilo se
 * guarda en el navegador (lib/chat-persist.ts) y los turnos viven en el
 * servidor (agent/chat-turns.ts). El manifest ayuda; el blindaje es ese.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OS",
    short_name: "OS",
    description: "AI Operating System personal de RuloCode",
    // Abre en el Laboratorio, igual que "/" (que redirige ahí). Se pone
    // explícito para que el icono de la pantalla de inicio del iPhone no
    // gaste un redirect en cada apertura.
    start_url: "/laboratorio",
    display: "standalone",
    orientation: "portrait",
    background_color: "#05060f",
    theme_color: "#05060f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
