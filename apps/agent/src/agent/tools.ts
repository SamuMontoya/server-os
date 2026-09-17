import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../env.js";
import { saveMemory, searchMemory, savePreference } from "../memory.js";
import { searchKnowledge, knowledgeToText } from "../knowledge.js";
import { readProjects } from "../vault/projects.js";
import { supabase } from "../supabase.js";
import { OWNER } from "../owner.js";
import { syncDriveFolder, extractFolderId } from "../drive/sync.js";
import { getFullChatDocument, listChatDocuments } from "../documents/chat-documents.js";

const execFileAsync = promisify(execFile);

const MEMORY_TYPES = ["user", "feedback", "project", "reference", "daily", "agent"] as const;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ── Tools MCP in-process del servidor "hermes" ─────────────────────────

const saveMemoryTool = tool(
  "save_memory",
  `Guarda una memoria persistente en Supabase (compartida entre todas las máquinas de ${OWNER}). Úsala al aprender algo nuevo sobre ${OWNER}, sus proyectos o al terminar tareas significativas. OJO: solo se recupera por búsqueda semántica/recencia del turno — NO garantiza aparecer en cada conversación futura. Si ${OWNER} pide recordar una REGLA DE COMPORTAMIENTO O FORMATO que aplica siempre (sin importar el tema), usa save_preference en vez de esta — esa sí se inyecta garantizado en cada turno.`,
  {
    content: z.string().describe("El contenido de la memoria, autocontenido y claro"),
    type: z.enum(MEMORY_TYPES).describe(`user=sobre ${OWNER}, feedback=correcciones, project=proyectos, reference=links/recursos, daily=diario, agent=aprendizajes propios`),
    project: z.string().optional().describe("Slug del proyecto relacionado (ej: ternium, zylen)"),
    tags: z.array(z.string()).optional(),
    importance: z.number().min(1).max(5).optional().describe("1=trivial, 5=crítico"),
  },
  async (args) => text(await saveMemory({ ...args, source: "agent" })),
);

const KNOWLEDGE_SOURCES = [
  "memory",
  "meeting",
  "execution",
  "conversation",
  "vault",
  "drive",
  "chat",
] as const;

const searchKnowledgeTool = tool(
  "search_knowledge",
  "Búsqueda semántica unificada en TODO lo que OS sabe: memorias, ejecuciones de tareas, conversaciones pasadas, notas del vault, documentos de Drive indexados y documentos que el usuario subió a mano en el chat. Primera opción para '¿en qué quedamos?', '¿qué sabemos de X?' o cualquier contexto histórico.",
  {
    query: z.string().describe("Qué buscar, en lenguaje natural"),
    sources: z
      .array(z.enum(KNOWLEDGE_SOURCES))
      .optional()
      .describe("Acotar a ciertas fuentes. Omitir para buscar en todas."),
    project: z.string().optional().describe("Slug del proyecto para acotar (ej: ternium)"),
    limit: z.number().max(20).optional(),
  },
  async ({ query, sources, project, limit }) => {
    const hits = await searchKnowledge(query, { sources, project, limit: limit ?? 10 });
    if (!hits.length) return text("Sin resultados en la base de conocimiento.");
    return text(knowledgeToText(hits));
  },
);

const searchMemoryTool = tool(
  "search_memory",
  "Búsqueda semántica en las memorias persistentes. Úsala antes de preguntar al usuario algo que ya podrías saber.",
  {
    query: z.string(),
    type: z.enum(MEMORY_TYPES).optional(),
    limit: z.number().max(20).optional(),
  },
  async ({ query, type, limit }) => {
    const results = await searchMemory(query, type, limit ?? 8);
    if (!results.length) return text("Sin resultados en memoria.");
    return text(
      results
        .map((m) => `[${m.type}${m.project_slug ? `·${m.project_slug}` : ""} ${m.created_at.slice(0, 10)}] ${m.content.slice(0, 400)}`)
        .join("\n---\n"),
    );
  },
);

const savePreferenceTool = tool(
  "save_preference",
  `Guarda una preferencia GLOBAL de ${OWNER} (clave-valor), que se inyecta garantizado en el system prompt de CADA turno futuro (a diferencia de save_memory, que depende de búsqueda semántica y puede no aparecer). Úsala para reglas de comportamiento/formato que valen siempre, sin scope de proyecto — ej: key='formato_tablas', value='siempre markdown, nunca ASCII'; key='package_manager', value='pnpm'. Si ${OWNER} dice "recuerda que...", "de ahora en adelante...", "siempre haz/no hagas X" sobre algo transversal, llama esta tool EN ESE MISMO TURNO, antes de responder que quedó anotado.`,
  { key: z.string(), value: z.string() },
  async ({ key, value }) => text(await savePreference(key, value)),
);

const getProjectStatusTool = tool(
  "get_project_status",
  "Lee el estado real de los proyectos desde el vault de Obsidian (frontmatter + Estado Actual + Tareas Pendientes). Sin argumentos devuelve todos los activos.",
  { project: z.string().optional().describe("Slug del proyecto (ej: ternium). Omitir para todos los activos.") },
  async ({ project }) => {
    const projects = await readProjects();
    const filtered = project
      ? projects.filter((p) => p.slug.toLowerCase() === project.toLowerCase())
      : projects.filter((p) => p.estado === "activo");
    if (!filtered.length) return text(`No encontré el proyecto "${project ?? "(activos)"}" en el vault.`);
    return text(
      filtered
        .map(
          (p) =>
            `# ${p.name} [${p.estado}]${p.rama ? ` rama:${p.rama}` : ""}\n## Estado Actual\n${p.estado_actual || "—"}\n## Tareas Pendientes\n${p.tareas_pendientes.map((t) => `- ${t}`).join("\n") || "—"}`,
        )
        .join("\n\n====\n\n"),
    );
  },
);

const updateProjectNoteTool = tool(
  "update_project_note",
  "Anexa una entrada con fecha a la sección 'Estado Actual' de la nota de un proyecto del vault. Es el flujo 'persistir aprendizajes' del AIOS.",
  {
    project: z.string().describe("Slug del proyecto (carpeta en projects/)"),
    content: z.string().describe("Texto a anexar (markdown)"),
  },
  async ({ project, content }) => {
    // Máquina sin vault local (VAULT_PATH=""): `join("", ...)` da una ruta
    // RELATIVA que Node resuelve contra el cwd del proceso @hermes/agent —
    // en la práctica, escribe basura dentro del propio repo en vez de fallar
    // claro. Documentado en .env.example: vacío = solo ejecución, no se
    // escriben notas (el dueño del vault es quien las persiste).
    if (!env.VAULT_PATH) {
      return text(
        "Esta máquina no tiene vault local (VAULT_PATH sin configurar) — no puedo escribir notas de proyecto acá. Pídele a la máquina dueña del vault que la actualice, o usa save_memory para dejar constancia igual.",
      );
    }
    const projects = await readProjects(true);
    const p = projects.find((x) => x.slug.toLowerCase() === project.toLowerCase());
    if (!p) return text(`Proyecto "${project}" no encontrado en el vault.`);
    const notePath = join(env.VAULT_PATH, "projects", p.slug, `${p.name}.md`);
    const raw = await readFile(notePath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const entry = `\n> [!note] OS · ${today}\n> ${content.replace(/\n/g, "\n> ")}\n`;
    // Insertar justo después del header "Estado Actual"
    const lines = raw.split("\n");
    const idx = lines.findIndex((l) => /^#{1,3}\s*.*Estado Actual/i.test(l));
    if (idx === -1) {
      await writeFile(notePath, raw + `\n## 📊 Estado Actual\n${entry}`, "utf8");
    } else {
      lines.splice(idx + 1, 0, entry);
      await writeFile(notePath, lines.join("\n"), "utf8");
    }
    return text(`Nota de ${p.name} actualizada (${notePath}).`);
  },
);

const searchVaultTool = tool(
  "search_vault",
  "Búsqueda de texto (read-only) sobre todo el vault de Obsidian con ripgrep.",
  {
    query: z.string(),
    folder: z.string().optional().describe("Subcarpeta del vault (ej: projects)"),
  },
  async ({ query, folder }) => {
    if (!env.VAULT_PATH) {
      return text(
        "Esta máquina no tiene vault local (VAULT_PATH sin configurar) — no hay nada que buscar acá. Prueba search_knowledge, que sí lee el espejo compartido.",
      );
    }
    const dir = folder ? join(env.VAULT_PATH, folder) : env.VAULT_PATH;
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-i", "--max-count", "3", "--max-columns", "240", "-g", "*.md", query, dir],
        { maxBuffer: 1024 * 512 },
      );
      return text(stdout.slice(0, 6000) || "Sin coincidencias.");
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1) return text("Sin coincidencias.");
      return text(`Error en búsqueda: ${String(err).slice(0, 300)}`);
    }
  },
);

const captureIdeaTool = tool(
  "capture_idea",
  "Captura una idea suelta: la escribe en '00 Inbox/' del vault y la espeja como memoria.",
  { content: z.string(), tags: z.array(z.string()).optional() },
  async ({ content, tags }) => {
    await saveMemory({ content, type: "agent", tags: [...(tags ?? []), "idea"], source: "agent" });
    // Sin VAULT_PATH, `join("", "00 Inbox")` da una ruta RELATIVA: Node la
    // resuelve contra el cwd del proceso @hermes/agent y termina escribiendo
    // basura dentro del propio repo en vez de en el vault de verdad (así se
    // detectó este bug). Igual que update_project_note/search_vault: en una
    // máquina "solo ejecución" (.env.example) no se toca el filesystem, la
    // memoria en Supabase ya quedó guardada arriba.
    if (!env.VAULT_PATH) {
      return text(
        "Guardada como memoria (Supabase) — esta máquina no tiene vault local (VAULT_PATH sin configurar), así que no se escribió el .md en 00 Inbox. La máquina dueña del vault puede volcarla a mano si hace falta.",
      );
    }
    const inbox = join(env.VAULT_PATH, "00 Inbox");
    await mkdir(inbox, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = join(inbox, `idea-${stamp}.md`);
    await appendFile(
      file,
      `---\ncapturada: ${new Date().toISOString()}\ntags: [${(tags ?? []).join(", ")}]\norigen: os\n---\n\n${content}\n`,
    );
    return text(`Idea capturada en ${file}`);
  },
);

const syncDriveFolderTool = tool(
  "sync_drive_folder",
  "Escanea una carpeta de Google Drive (URL o ID, recursivo) y vectoriza sus documentos (PDF/DOCX/XLSX) en la base de conocimiento — quedan buscables por search_knowledge (fuente 'drive'). Requiere la carpeta compartida con la cuenta de servicio configurada (GOOGLE_DRIVE_SA_KEY_PATH). Reusable: se puede correr de nuevo sobre la misma carpeta (solo re-indexa lo que cambió) o sobre una carpeta distinta.",
  {
    folder: z.string().describe("URL de Google Drive (https://drive.google.com/drive/folders/...) o el ID pelado de la carpeta"),
  },
  async ({ folder }) => {
    const folderId = extractFolderId(folder);
    if (!folderId) return text(`No reconocí un folder ID válido en "${folder}".`);
    const result = await syncDriveFolder(folderId);
    if (!result) {
      return text(
        "No se pudo sincronizar. Revisa: GOOGLE_DRIVE_SA_KEY_PATH en .env, que la migración 030_drive_docs.sql esté aplicada en Supabase, y que la carpeta esté compartida con la service account.",
      );
    }
    return text(
      `Sincronizado ✓ ${result.indexed} documentos indexados/actualizados · ${result.scanned} escaneados · ${result.skipped} sin texto extraíble · ${result.removed} eliminados del índice (ya no están en la carpeta).`,
    );
  },
);

const readChatDocumentTool = tool(
  "read_chat_document",
  "Devuelve el texto COMPLETO (todos los fragmentos, en orden) de un documento que el usuario subio a mano en el chat (PDF/DOCX/XLSX/etc). Usala cuando necesites reconstruir un documento fielmente -toda una matriz de auditoria, todas las filas y columnas de una tabla, etc- a diferencia de search_knowledge, que solo trae fragmentos sueltos por similitud semantica y puede repetir el mismo trozo si el documento tiene muchos chunks. Si no sabes el nombre exacto, usa antes list_chat_documents.",
  {
    name: z.string().describe("Nombre (o parte del nombre) del archivo subido al chat, o su doc_id exacto"),
  },
  async ({ name }) => {
    const doc = await getFullChatDocument(name);
    if (!doc) {
      return text(
        `No encontre ningun documento subido al chat que coincida con "${name}". Usa list_chat_documents para ver los disponibles.`,
      );
    }
    return text(
      `# ${doc.name} (${doc.chunkCount} fragmento(s), subido ${doc.createdAt.slice(0, 10)})\n\n${doc.content}`,
    );
  },
);

const listChatDocumentsTool = tool(
  "list_chat_documents",
  "Lista los documentos que el usuario subio a mano en el chat (el clip junto al microfono), mas recientes primero -para saber que nombre pasarle a read_chat_document.",
  { limit: z.number().max(50).optional() },
  async ({ limit }) => {
    const docs = await listChatDocuments(limit ?? 20);
    if (!docs.length) return text("No hay documentos subidos al chat.");
    return text(
      docs
        .map((d) => `- ${d.name} (${d.chunkCount} fragmento(s), ${d.createdAt.slice(0, 10)})`)
        .join("\n"),
    );
  },
);

const getRecentActivityTool = tool(
  "get_recent_activity",
  "Devuelve la actividad reciente del agente (sesiones y acciones) para responder '¿en qué quedamos?'.",
  { limit: z.number().max(50).optional() },
  async ({ limit }) => {
    if (!supabase) return text("Supabase no configurado: sin historial.");
    const { data } = await supabase
      .from("agent_activity")
      .select("kind,tool_name,payload,machine,created_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    if (!data?.length) return text("Sin actividad registrada.");
    return text(
      data
        .map((a) => `${a.created_at.slice(0, 16)} [${a.machine}] ${a.kind}${a.tool_name ? `:${a.tool_name}` : ""} ${JSON.stringify(a.payload).slice(0, 120)}`)
        .join("\n"),
    );
  },
);


// El tipo sale de la firma del propio SDK: cada tool tiene su schema y
// tiparlas con el de UNA sola las hace incompatibles entre sí.
// `tools` es opcional en la firma, de ahí el NonNullable antes de indexar.
type AnyTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];

/**
 * Además de la feature, una tool puede exigir que su HARDWARE exista. Es la
 * misma idea llevada un paso más allá: `null` no debería significar "se carga
 * aunque no pueda hacer nada". Una tool que solo puede contestar "no está
 * configurado" cuesta su schema en cada turno y le ofrece al modelo una
 * capacidad que no tiene.
 */
// Catálogo completo: sin las 9 features que existían para apagar, ya no hace
// falta ningún filtro — cada tool que se define acá se registra siempre.
const ACTIVE_TOOLS: AnyTool[] = [
  searchKnowledgeTool,
  saveMemoryTool,
  searchMemoryTool,
  savePreferenceTool,
  getProjectStatusTool,
  updateProjectNoteTool,
  searchVaultTool,
  captureIdeaTool,
  getRecentActivityTool,
  syncDriveFolderTool,
  readChatDocumentTool,
  listChatDocumentsTool,
];

export const hermesMcpServer = createSdkMcpServer({
  name: "hermes",
  version: "0.1.0",
  tools: ACTIVE_TOOLS,
});

/**
 * Nombres completos para allowedTools. Se DERIVAN de las tools activas: una
 * lista fija autorizaría herramientas que ya no se registran.
 */
export const HERMES_TOOL_NAMES = ACTIVE_TOOLS.map((tool) => `mcp__hermes__${tool.name}`);
