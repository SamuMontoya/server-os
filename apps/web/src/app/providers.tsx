"use client";

import { HermesDataProvider } from "@/state/HermesDataProvider";
import { AgentEventsProvider } from "@/state/AgentEventsProvider";
import { OrchestratorProvider } from "@/state/OrchestratorProvider";
import { DashboardProvider } from "@/state/DashboardProvider";
import { WorkspaceProvider } from "@/state/WorkspaceContext";
import { DocViewerProvider } from "@/components/DocViewer";
import { AppShell } from "@/components/shell/AppShell";
import { BootGate } from "@/components/boot/BootGate";
import { usePathname } from "next/navigation";
import { iniciarTokenSync } from "@/lib/auth/token";

/**
 * Árbol ÚNICO de providers de toda la app (vive en el layout, persiste entre
 * navegaciones):
 *  - HermesDataProvider    → poll único de stats+proyectos+memorias (10s)
 *  - AgentEventsProvider   → SSE único del bus de actividad
 *  - WorkspaceProvider     → tab central, foco de proyecto, sesión de Claude
 *  - DocViewerProvider     → visor global de docs .md del vault
 *  - BootGate              → cortina de arranque (BootLoader) sobre el AppShell;
 *                            lee online/snapshot/connected y se desmonta al cargar
 * AppShell monta header + vistas (Orquestador·Chat) y las alterna con CSS.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // El login va DESNUDO, fuera de todo el árbol. Montar los providers ahí
  // arrancaría los polls al agente y el BootGate antes de que nadie haya
  // entrado — trabajo (y errores en consola) de una pantalla cuyo único fin
  // es autenticar.
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;

  // Mantiene el access token al día para que hermesFetch/sseUrl —que son
  // síncronas— puedan leerlo sin volverse promesas.
  iniciarTokenSync();

  return (
    <HermesDataProvider>
      <AgentEventsProvider>
        <OrchestratorProvider>
          <DashboardProvider>
            <WorkspaceProvider>
              <DocViewerProvider>
                <BootGate>
                  <AppShell>{children}</AppShell>
                </BootGate>
              </DocViewerProvider>
            </WorkspaceProvider>
          </DashboardProvider>
        </OrchestratorProvider>
      </AgentEventsProvider>
    </HermesDataProvider>
  );
}
