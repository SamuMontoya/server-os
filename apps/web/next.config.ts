import type { NextConfig } from "next";
import { resolve } from "node:path";

// apps/web corre en su propio directorio, pero el `.env` vive en la RAÍZ del
// monorepo (convención del proyecto). Next no lo lee solo, así que lo cargamos
// aquí para exponer NEXT_PUBLIC_* al cliente (p.ej. NEXT_PUBLIC_HERMES_URL) y
// las vars server-side (ELEVENLABS_*) a las rutas API. Sin dependencias:
// process.loadEnvFile existe en Node 20.12+/22.
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
    resolve(process.cwd(), "../../.env"),
  );
} catch {
  /* sin .env raíz o Node antiguo: se usan los defaults del código */
}

// Directorio de salida del build. Por defecto `.next`, pero el deploy del
// servidor compila a OTRO directorio y solo lo intercambia si el build
// terminó bien: `next build` VACÍA su distDir al arrancar, así que compilar
// sobre el que está sirviendo destruye el dashboard en cuanto el build falla
// —y en una máquina de 3.2 GB falla por OOM. Ver scripts/deploy-linux.sh.
// Se pasa por el entorno del comando, NUNCA en el `.env`: `next start` tiene
// que seguir leyendo `.next`.
const distDir = process.env.HERMES_WEB_DIST_DIR || ".next";

const nextConfig: NextConfig = {
  distDir,
  // /orquestador se fusionó al dashboard (tab TAREAS); los links viejos siguen
  // vivos vía redirect permanente.
  redirects: async () => [{ source: "/orquestador", destination: "/", permanent: true }],
  // @hermes/shared se consume como TS crudo (main: src/index.ts) con imports
  // ESM "./types.js": transpilar el package y mapear .js → .ts para que
  // webpack resuelva igual que tsx/tsc. Necesario desde que la web importa
  // VALORES del shared (FINANCE_CATEGORIES), no solo tipos.
  transpilePackages: ["@hermes/shared"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
