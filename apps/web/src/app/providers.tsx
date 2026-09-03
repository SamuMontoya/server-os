"use client";

import { ConversationProvider } from "@elevenlabs/react";
import { VoiceBusyProvider } from "@/components/VoiceBusyContext";
import { HermesDataProvider } from "@/state/HermesDataProvider";
import { AgentEventsProvider } from "@/state/AgentEventsProvider";
import { OrchestratorProvider } from "@/state/OrchestratorProvider";
import { DashboardProvider } from "@/state/DashboardProvider";
import { WorkspaceProvider } from "@/state/WorkspaceContext";
import { VidaProvider } from "@/state/VidaProvider";
import { EstudioProvider } from "@/state/EstudioProvider";
import { LiveMeetingProvider } from "@/state/LiveMeetingProvider";
import { DocViewerProvider } from "@/components/DocViewer";
import { AppShell } from "@/components/shell/AppShell";
import { BootGate } from "@/components/boot/BootGate";
import { usePathname } from "next/navigation";
import { iniciarTokenSync } from "@/lib/auth/token";

/**
 * Árbol ÚNICO de providers de toda la app (vive en el layout, persiste entre
 * navegaciones):
 *  - ConversationProvider  → la llamada de voz sobrevive al cambiar de vista
 *  - VoiceBusyProvider     → transcript/artefactos/scope compartidos
 *  - HermesDataProvider    → poll único de stats+proyectos+memorias (10s)
 *  - AgentEventsProvider   → SSE único del bus de actividad
 *  - WorkspaceProvider     → tab central, foco de proyecto, sesión de Claude
 *  - VidaProvider          → poll único de finanzas+hábitos (Finanzas·Hábitos·Inglés)
 *  - EstudioProvider       → poll único del pipeline de contenido (ESTUDIO)
 *  - LiveMeetingProvider   → junta EN VIVO (mic + WS): sobrevive a navegar
 *  - DocViewerProvider     → visor global de docs .md del vault
 *  - BootGate              → cortina de arranque (BootLoader) sobre el AppShell;
 *                            lee online/snapshot/connected y se desmonta al cargar
 * AppShell monta header + vistas (Orquestador·Finanzas·Hábitos·Inglés·Agenda)
 * y las alterna con CSS.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // El login va DESNUDO, fuera de todo el árbol. Montar los providers ahí
  // arrancaría los polls al agente, la sesión de voz y el BootGate antes de
  // que nadie haya entrado — trabajo (y errores en consola) de una pantalla
  // cuyo único fin es autenticar.
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;

  // Mantiene el access token al día para que hermesFetch/sseUrl —que son
  // síncronas— puedan leerlo sin volverse promesas.
  iniciarTokenSync();

  return (
    <ConversationProvider>
      <VoiceBusyProvider>
        <HermesDataProvider>
          <AgentEventsProvider>
            <OrchestratorProvider>
              <DashboardProvider>
                <WorkspaceProvider>
                  <VidaProvider>
                    <EstudioProvider>
                    <LiveMeetingProvider>
                      <DocViewerProvider>
                        <BootGate>
                          <AppShell>{children}</AppShell>
                        </BootGate>
                      </DocViewerProvider>
                    </LiveMeetingProvider>
                    </EstudioProvider>
                  </VidaProvider>
                </WorkspaceProvider>
              </DashboardProvider>
            </OrchestratorProvider>
          </AgentEventsProvider>
        </HermesDataProvider>
      </VoiceBusyProvider>
    </ConversationProvider>
  );
}
