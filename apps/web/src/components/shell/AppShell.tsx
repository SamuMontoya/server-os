"use client";

// Shell del workspace: rail de iconos + topbar + vistas.
// Vive en el layout, así que PERSISTE entre navegaciones: las vistas se montan
// una vez y se alternan con CSS — los streams de la consola sobreviven al
// cambiar de vista.
// Rutas fuera del workspace (p. ej. /dev/ui, /laboratorio) se renderizan sin shell.

import { usePathname } from "next/navigation";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useHotkeys } from "@/hooks/useHotkeys";
import { SideRail } from "./SideRail";
import { TopBar } from "./TopBar";
import { Toasts } from "@/components/Toasts";
import { CommandPalette } from "@/components/CommandPalette";
import { OrquestadorView } from "@/components/views/OrquestadorView";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { events } = useAgentEvents();
  // Atajos globales: ⌘K palette · ⌘1..4 tabs · ⌘B sidebar · Esc.
  useHotkeys();

  // Fuera del workspace (galería /dev/ui, el chat en /laboratorio, futuras
  // rutas sueltas): sin shell. "/os" es el dashboard secundario (el chat
  // principal vive en /laboratorio, ver app/page.tsx). "/" se deja mapeado
  // por si alguna navegación vieja o un enlace guardado llega ahí antes del
  // redirect: no cuesta nada y evita que esa ruta se renderice sin shell.
  const WORKSPACE_VIEWS: Record<string, string> = {
    "/os": "orquestador",
    "/": "orquestador",
  };
  const view = WORKSPACE_VIEWS[pathname];
  if (!view) return <>{children}</>;

  return (
    <>
      <div className="relative z-2 flex h-screen">
        <SideRail />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className={`min-h-0 flex-1 ${view === "orquestador" ? "flex flex-col" : "hidden"}`}>
              <OrquestadorView />
            </div>
          </div>
        </main>
      </div>

      {/* Avisos flotantes de tareas/runs terminados (mismo SSE de events) */}
      <Toasts events={events} />
      {/* Palette de comandos (⌘K) */}
      <CommandPalette />
      {/* children = páginas marcador (devuelven null); deja el slot presente */}
      {children}
    </>
  );
}
