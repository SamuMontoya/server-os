"use client";

// Registry ÚNICO de comandos del workspace: alimenta el Command Deck, los
// chips de la consola y la palette (⌘K). Cada comando ejecuta una capacidad
// REAL existente — nada decorativo: si no hay capacidad detrás, no hay botón.

import { useRouter } from "next/navigation";
import { hermesPost } from "@/lib/hermes";
import { useWorkspace, type CenterTab } from "@/state/WorkspaceContext";

export interface CommandContext {
  selectedProject: string | null;
  showPanel: (tab: CenterTab) => void;
  focusProject: (slug: string | null) => void;
  launchClaudeRun: (opts: { project: string; prompt: string }) => Promise<{ runId: string } | null>;
  /** POST /tasks (agente SDK) y muestra la actividad en vivo. */
  runTask: (prompt: string) => Promise<void>;
  /** Precarga el input de la consola y salta a ella. */
  insertConsolePrompt: (text: string) => void;
  /** Navega a una ruta del workspace. */
  navigate: (path: string) => void;
}

export interface HermesCommand {
  id: string;
  label: string;
  /** Cómo se muestra como chip bajo la consola (si aplica). */
  slash?: string;
  hint?: string;
  /** Deshabilitado sin proyecto en foco. */
  requiresProject?: boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export const COMMANDS: HermesCommand[] = [
  {
    id: "pulse-check",
    label: "Pulse Check",
    hint: "Estado y próximos pasos de cada proyecto activo del vault",
    run: (ctx) =>
      ctx.runTask(
        "Haz el Pulse Check del AIOS: lee el Estado Actual y Tareas Pendientes de cada proyecto activo del vault y dame un resumen de 3-6 líneas por proyecto con próximos pasos.",
      ),
  },
  {
    id: "resumen-dia",
    label: "Resumen del día",
    slash: "/resumen diario",
    hint: "Qué se hizo hoy y qué queda pendiente",
    run: (ctx) =>
      ctx.runTask(
        "Revisa la actividad reciente del agente y las memorias de hoy, y dame un resumen de qué se hizo hoy y qué queda pendiente.",
      ),
  },
  {
    id: "destilar-memorias",
    label: "Destilar memorias",
    hint: "Curar aprendizajes de los daily de la semana",
    run: (ctx) =>
      ctx.runTask(
        "Busca las memorias tipo daily de los últimos 7 días, destila los aprendizajes importantes y guárdalos como memorias curadas (type agent o feedback según corresponda).",
      ),
  },
  {
    id: "sync-proyectos",
    label: "Sync proyectos",
    hint: "Snapshot del estado de cada proyecto activo a memoria",
    run: (ctx) =>
      ctx.runTask(
        "Lee el estado de todos los proyectos del vault y actualiza la memoria con un snapshot del estado actual de cada proyecto activo.",
      ),
  },
  {
    id: "analizar-proyecto",
    label: "Analizar proyecto",
    slash: "/analizar proyecto",
    hint: "Claude analiza el repo del proyecto en foco",
    requiresProject: true,
    run: (ctx) => {
      if (!ctx.selectedProject) return;
      void ctx.launchClaudeRun({
        project: ctx.selectedProject,
        prompt:
          "Analiza el estado actual de este repo: rama, cambios sin commitear, TODOs recientes y deuda técnica visible. Dame un reporte corto con próximos pasos concretos. No hagas cambios.",
      });
    },
  },
  {
    id: "revisar-codigo",
    label: "Revisar código",
    slash: "/revisar código",
    hint: "Claude revisa el diff sin commitear del repo en foco",
    requiresProject: true,
    run: (ctx) => {
      if (!ctx.selectedProject) return;
      void ctx.launchClaudeRun({
        project: ctx.selectedProject,
        prompt:
          "Revisa el diff sin commitear de este repo (git status + git diff). Reporta bugs, riesgos y mejoras concretas con archivo:línea. No hagas cambios.",
      });
    },
  },
  {
    id: "planificar-dia",
    label: "Planificar día",
    slash: "/planificar día",
    hint: "Precarga un plan del día en la consola",
    run: (ctx) =>
      ctx.insertConsolePrompt(
        "Arma mi plan del día: usa el brief diario, revisa las tareas pendientes del tracker y el estado de los proyectos activos, y proponme un plan priorizado de 3-5 bloques con tiempos.",
      ),
  },
  {
    id: "editar-video-divisual",
    label: "Editar vídeo (Divisual)",
    hint: "Edición real con la skill divisual-edit (deja el vídeo en input/ del kit)",
    // Capacidad ejecutable de Divisual: corre como Claude Code EN el repo del
    // kit (cwd = ruta_local) para tener sus skills a mano — no como /tasks.
    run: (ctx) => {
      void ctx.launchClaudeRun({
        project: "divisual",
        prompt:
          "Edita el vídeo que esté en input/ usando la skill divisual-edit. Detecta el formato (horizontal/vertical/cuadrado), corta silencios, retakes y muletillas, añade motion graphics según styles/triggers.md y subtítulos con el estilo de styles/client-style.md (si no existe, sigue el onboarding de estilo del CLAUDE.md). Deja el vídeo final en output/. Si input/ está vacío, dilo y no hagas nada más.",
      });
    },
  },
];

/** Grid del Command Deck (orden de la referencia). */
export const DECK_IDS = [
  "pulse-check",
  "resumen-dia",
  "analizar-proyecto",
  "revisar-codigo",
  "destilar-memorias",
  "editar-video-divisual",
];

/** Chips bajo el input de la consola (solo los que tienen slash). */
export const CHIP_IDS = [
  "resumen-dia",
  "analizar-proyecto",
  "revisar-codigo",
  "planificar-dia",
];

/** Arma el contexto de ejecución desde el workspace (hook de conveniencia). */
export function useCommandContext(): CommandContext {
  const ws = useWorkspace();
  const router = useRouter();
  return {
    navigate: (path) => router.push(path),
    selectedProject: ws.selectedProject,
    showPanel: ws.showPanel,
    focusProject: ws.focusProject,
    launchClaudeRun: ws.launchClaudeRun,
    runTask: async (prompt) => {
      try {
        await hermesPost<{ task_id: string }>("/tasks", { prompt });
        ws.showPanel("actividad");
      } catch {
        /* offline: el feed ya lo refleja */
      }
    },
    insertConsolePrompt: (text) => {
      ws.setConsoleDraft(text);
      ws.showPanel("consola");
    },
  };
}
