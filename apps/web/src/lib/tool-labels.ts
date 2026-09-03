/**
 * Cómo se LEE un tool_use del SDK: verbo en español, glifo y objetivo corto.
 *
 * Vivía dentro de AgentSteps (el HUD oscuro). Se sacó acá cuando el
 * Laboratorio necesitó pintar los mismos pasos con otra piel (LabSteps): el
 * vocabulario —qué verbo le toca a `Read`, cómo se acorta una ruta— es del
 * DOMINIO, no de un componente. Duplicarlo garantizaba que un día el chat
 * dijera "Leyó" y el laboratorio "Read".
 */

// Verbo en pasado por tool. Las mcp__hermes__* se buscan sin su prefijo.
const VERB: Record<string, string> = {
  Read: "Leyó",
  Glob: "Listó",
  Grep: "Buscó",
  Bash: "Ejecutó",
  Write: "Escribió",
  Edit: "Editó",
  WebSearch: "Buscó en la web",
  WebFetch: "Abrió",
  TodoWrite: "Actualizó el plan",
  ToolSearch: "Cargó herramientas",
  Task: "Lanzó un subagente",
  search_knowledge: "Buscó en el conocimiento",
  save_memory: "Guardó en memoria",
  search_memory: "Buscó en la memoria",
  save_preference: "Guardó una preferencia",
  get_project_status: "Leyó el estado del proyecto",
  update_project_note: "Actualizó la nota del proyecto",
  search_vault: "Buscó en el vault",
  capture_idea: "Capturó una idea",
  get_recent_activity: "Leyó la actividad reciente",
  search_meetings: "Buscó en reuniones",
  analyze_youtube: "Analizó un video",
  log_transaction: "Registró una transacción",
  list_transactions: "Listó transacciones",
  get_finance_summary: "Leyó el resumen financiero",
  get_balance: "Leyó el saldo",
  set_wallet_balance: "Ajustó el saldo",
  set_budget: "Ajustó el presupuesto",
  log_habit: "Registró un hábito",
  get_habits_today: "Leyó los hábitos de hoy",
  manage_habit: "Gestionó un hábito",
  update_goal: "Actualizó una meta",
};

/**
 * Verbo en PRESENTE, para el paso que está corriendo ahora mismo.
 *
 * El pasado ("Leyó") miente mientras la tool todavía no volvió: el paso en
 * curso es lo único que el Laboratorio muestra durante el stream, así que ahí
 * tiene que decir "Leyendo". Solo se traducen los de uso diario; lo que no
 * esté acá cae al verbo en pasado (mejor eso que inventar una conjugación).
 */
const VERB_LIVE: Record<string, string> = {
  Read: "Leyendo",
  Glob: "Listando",
  Grep: "Buscando",
  Bash: "Ejecutando",
  Write: "Escribiendo",
  Edit: "Editando",
  WebSearch: "Buscando en la web",
  WebFetch: "Abriendo",
  TodoWrite: "Actualizando el plan",
  ToolSearch: "Cargando herramientas",
  Task: "Lanzando un subagente",
  search_knowledge: "Buscando en el conocimiento",
  save_memory: "Guardando en memoria",
  search_memory: "Buscando en la memoria",
  save_preference: "Guardando una preferencia",
  get_project_status: "Leyendo el estado del proyecto",
  update_project_note: "Actualizando la nota del proyecto",
  search_vault: "Buscando en el vault",
  capture_idea: "Capturando una idea",
  get_recent_activity: "Leyendo la actividad reciente",
  search_meetings: "Buscando en reuniones",
  analyze_youtube: "Analizando un video",
};

// Glifo por familia de tool (mismo vocabulario que la Actividad en vivo).
const GLYPH: Record<string, string> = {
  Read: "⌕",
  Glob: "⌕",
  Grep: "⌕",
  Bash: "❯",
  Write: "✎",
  Edit: "✎",
  WebSearch: "◈",
  WebFetch: "◈",
  TodoWrite: "☰",
  ToolSearch: "⚙",
  Task: "◆",
};

/** Nombre corto de la tool: mcp__hermes__save_memory → save_memory. */
export function shortName(name: string): string {
  return name.startsWith("mcp__") ? (name.split("__").pop() ?? name) : name;
}

/**
 * Etiqueta legible; sin verbo conocido cae al nombre crudo (nunca inventa).
 * Con `live` usa el presente y, si esa tool no lo tiene, el pasado.
 */
export function verbOf(name: string, live = false): string {
  const short = shortName(name);
  if (live) {
    const now = VERB_LIVE[name] ?? VERB_LIVE[short];
    if (now) return now;
  }
  return VERB[name] ?? VERB[short] ?? short;
}

export function glyphOf(name: string): string {
  return GLYPH[name] ?? (name.startsWith("mcp__") ? "◆" : "⚙");
}

/** Acorta el objetivo: URLs → host, rutas → últimos 2 segmentos, texto → 60. */
export function shortTarget(target: string): string {
  const t = target.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/^https?:\/\//.test(t)) {
    try {
      return new URL(t).hostname;
    } catch {
      /* URL rota: cae al recorte de abajo */
    }
  }
  if (t.includes("/") && !t.includes(" ")) {
    const parts = t.split("/").filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join("/") : t;
  }
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}
