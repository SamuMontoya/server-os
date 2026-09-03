import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";
import { readProjects, resolveProjectRoot } from "./vault/projects.js";

// Grafo de código (graphify): indexa cada repo con tree-sitter (AST puro, sin
// LLM) a <repo>/graphify-out/graph.json y responde consultas de estructura vía
// BFS. Multi-repo: hermes-os (este monorepo) + los proyectos activos del vault
// con ruta_local que existe y es git. Lógica compartida tool + job.

const execFileAsync = promisify(execFile);

// Slug reservado para el propio monorepo (siempre indexable, sin pasar por el vault).
const SELF_SLUG = "hermes-os";

const exists = (p: string) => access(p).then(() => true, () => false);
const graphJson = (root: string) => join(root, "graphify-out", "graph.json");

/**
 * Ejecuta graphify sobre `root` (cwd + --graph absoluto donde aplica: no
 * dependemos del cwd del servicio launchd). Se retiran las API keys de LLM del
 * entorno hijo: el grafo de código es AST puro y así graphify jamás gasta
 * tokens por su cuenta (nombrar comunidades es manual: `graphify label .`).
 */
async function run(root: string, args: string[], timeoutMs: number): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]) {
    delete childEnv[key];
  }
  const { stdout } = await execFileAsync(env.GRAPHIFY_BIN, args, {
    cwd: root,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4,
    env: childEnv,
  });
  return stdout;
}

export type GraphMode = "query" | "path" | "explain";
export interface IndexableRepo {
  slug: string;
  root: string;
}

/** Repos indexables: hermes-os + proyectos activos con ruta_local que existe y es git. */
export async function indexableRepos(): Promise<IndexableRepo[]> {
  const repos: IndexableRepo[] = [{ slug: SELF_SLUG, root: env.CODE_GRAPH_ROOT }];
  for (const p of await readProjects()) {
    if (p.estado !== "activo") continue;
    // El repo se resuelve contra el disco de ESTA máquina: en otro PC los
    // clones viven en otra carpeta y la ruta_local del vault no aplica.
    const root = resolveProjectRoot(p);
    if (root && (await exists(join(root, ".git")))) repos.push({ slug: p.slug, root });
  }
  return repos;
}

/**
 * Resuelve un `project` (slug o nombre, tolerante a parciales) a su raíz de
 * repo. Sin project → el propio monorepo. `error` (accionable) cuando el
 * proyecto no se conoce o su ruta_local está rota.
 */
async function resolveRoot(project?: string): Promise<{ root?: string; error?: string }> {
  if (!project || project.toLowerCase() === SELF_SLUG || project.toLowerCase() === "hermes") {
    return { root: env.CODE_GRAPH_ROOT };
  }
  const q = project.toLowerCase();
  const projects = await readProjects();
  const p =
    projects.find((x) => x.slug.toLowerCase() === q || x.name.toLowerCase() === q) ??
    projects.find((x) => x.slug.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
  if (!p) {
    const known = (await indexableRepos()).map((r) => r.slug).join(", ");
    return { error: `No conozco un proyecto "${project}". Proyectos indexables: ${known}.` };
  }
  const root = resolveProjectRoot(p);
  if (!root) {
    return {
      error: `No encontré el repo de "${p.slug}" en esta máquina (${env.MACHINE_NAME}). Vault: ${p.ruta_local ?? "sin ruta_local"}; clones locales: ${env.CODE_ROOT}.`,
    };
  }
  if (!(await exists(join(root, ".git")))) {
    return { error: `El proyecto "${p.slug}" apunta a ${root}, que no es un repo git en esta máquina.` };
  }
  return { root };
}

/** Consulta el grafo de un repo. Nunca lanza: todo error vuelve como texto accionable para el LLM. */
export async function queryCodeGraph(mode: GraphMode, query: string, target?: string, project?: string): Promise<string> {
  if (!(await exists(env.GRAPHIFY_BIN))) {
    return `graphify no está instalado (esperado en ${env.GRAPHIFY_BIN}). Instálalo con: uv tool install "graphifyy[sql,openai]"`;
  }
  const { root, error } = await resolveRoot(project);
  if (error) return error;
  const gj = graphJson(root!);
  if (!(await exists(gj))) {
    return `El grafo de "${project ?? SELF_SLUG}" no existe aún. Constrúyelo con: cd ${root} && graphify extract . --code-only — o espera al job "code-graph-update".`;
  }
  const args =
    mode === "path"
      ? ["path", query, target ?? "", "--graph", gj]
      : [mode, query, "--graph", gj];
  try {
    const out = (await run(root!, args, 30_000)).trim();
    return out.slice(0, 8000) || "graphify no devolvió resultados para esa consulta.";
  } catch (err) {
    const e = err as { killed?: boolean; stderr?: string; message?: string };
    if (e.killed) return "La consulta al grafo excedió 30s (timeout). Intenta una pregunta más acotada.";
    return `Error de graphify: ${(e.stderr || e.message || String(err)).slice(0, 400)}`;
  }
}

export async function updateCodeGraph(): Promise<{ total: number; updated: number; built: number; failed: number } | null> {
  if (!(await exists(env.GRAPHIFY_BIN))) return null; // sin binario instalado: skipped, no error
  const repos = await indexableRepos();
  let updated = 0;
  let built = 0;
  let failed = 0;
  for (const { root } of repos) {
    try {
      if (await exists(graphJson(root))) {
        await run(root, ["update", "."], 10 * 60_000);
        updated++;
      } else {
        await run(root, ["extract", ".", "--code-only"], 10 * 60_000);
        built++;
      }
    } catch {
      failed++; // un repo roto/lento no debe frustrar el refresco de los demás
    }
  }
  return { total: repos.length, updated, built, failed };
}
