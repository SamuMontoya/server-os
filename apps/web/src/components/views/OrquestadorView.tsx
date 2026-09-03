"use client";

// Vista ORQUESTADOR (home secundario — el chat principal vive en /chat).
//
// Sin voz (ElevenLabs) ni Linear ni juntas: lo que queda es la consola de
// texto (ChatPanel, un chat más simple y sin memoria de conversación entre
// sesiones — el chat con memoria de verdad es /chat), la actividad en vivo,
// la memoria/conocimiento y la terminal de Claude Code. El resto de tabs se
// alternan con CSS (mismo patrón que antes: no se pierde scroll/estado al
// cambiar de tab).

import { useState } from "react";
import { claudeStartRun, continueTask } from "@/lib/hermes";
import { useHermesData } from "@/hooks/useHermesData";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useWorkspace } from "@/state/WorkspaceContext";
import { ChatPanel } from "@/components/ChatPanel";
import { ClaudeTerminal } from "@/components/ClaudeTerminal";
import { ActivityFeed } from "@/components/ActivityFeed";
import { MemoryView } from "@/components/views/MemoryView";
import { ContextRail } from "@/components/views/ContextRail";
import { CommandChips } from "@/components/CommandChips";

export function OrquestadorView() {
  const { memories, online } = useHermesData();
  const { events } = useAgentEvents();
  const ws = useWorkspace();
  const [consolaVacia, setConsolaVacia] = useState(true);

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {/* ── Centro ───────────────────────────────────────────── */}
      <section className="relative flex min-h-0 flex-1 flex-col items-center">
        <div
          className={`flex w-full min-h-0 flex-1 flex-col ${ws.tab === "consola" ? "" : "hidden"} max-w-[760px]`}
        >
          <ChatPanel
            online={online}
            selectedProject={ws.selectedProject}
            projectName={ws.selectedProjectName}
            onClearProject={() => ws.focusProject(null)}
            claudeConfig={ws.claudeConfig}
            onClaudeConfigChange={ws.setClaudeConfig}
            claudeSessionId={ws.claudeSessionId}
            externalDraft={ws.consoleDraft}
            onExternalDraftConsumed={() => ws.setConsoleDraft(null)}
            onEmptyChange={setConsolaVacia}
            onClaudeRun={(id, sessionId) => {
              ws.setClaudeRun(id, sessionId);
              ws.setTab("claude");
            }}
          />
          {consolaVacia && (
            <div className="mt-3 shrink-0">
              <CommandChips />
            </div>
          )}
        </div>

        {/* Resto de tabs: montados y alternados con CSS para no perder
            scroll/streams al cambiar (misma regla que antes). */}
        <TabPanel show={ws.tab === "actividad"}>
          <ActivityFeed events={events} />
        </TabPanel>
        <TabPanel show={ws.tab === "memoria"}>
          <MemoryView memories={memories} online={online} />
        </TabPanel>
        <TabPanel show={ws.tab === "claude"}>
          <ClaudeTerminal
            project={ws.selectedProject}
            runId={ws.claudeRunId}
            sessionId={ws.claudeSessionId}
            onSelectSession={(id) => {
              if (id === ws.claudeSessionId && ws.claudeRunId) return;
              ws.setClaudeRun(null, id);
            }}
            onNewSession={() => ws.setClaudeRun(null, null)}
            onSend={async (prompt) => {
              // Tarea activa → continueTask: misma sesión Y la ejecución
              // queda en la memoria de la tarea (vault + Supabase).
              if (ws.claudeTaskId) {
                const run = await continueTask(ws.claudeTaskId, prompt);
                if (run) ws.setClaudeRun(run.runId, run.sessionId);
                return run;
              }
              // Sesión suelta: resume (o arranca) con la config de la barra.
              try {
                const r = await claudeStartRun(
                  prompt,
                  ws.claudeConfig,
                  ws.selectedProject,
                  ws.claudeSessionId,
                );
                ws.setClaudeRun(r.runId, r.sessionId);
                return r;
              } catch {
                return null;
              }
            }}
          />
        </TabPanel>
      </section>

      {/* ── Riel de contexto ─────────────────────────────────── */}
      <aside
        aria-label="Contexto"
        className="hidden w-[264px] shrink-0 border-l border-line lg:flex lg:flex-col"
      >
        <ContextRail />
      </aside>
    </div>
  );
}

function TabPanel({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <div className={`w-full min-h-0 flex-1 ${show ? "flex flex-col" : "hidden"}`}>{children}</div>
  );
}
