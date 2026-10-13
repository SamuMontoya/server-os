-- Épica G, G1 (motor genérico de creación/edición de skills por conversación):
-- las 8 GEMS originales viven hardcodeadas en apps/agent/src/agent/skills.ts
-- (SKILL_PROMPTS) porque son fijas y curadas a mano. Esta tabla es para
-- skills NUEVAS que Jaime pide crear/editar DESDE la conversación (ej. "crea
-- un skill que resuma videos de YouTube") — no requieren deploy de código.
--
-- Samu es el único usuario de esta instancia (igual que watch_link, feedback
-- centralizado, etc.), así que no hay scoping por user_id: una fila = un
-- skill custom disponible para activar desde SkillSelector junto a los 8
-- fijos (ver GET /skills en routes/chat.ts y el merge en skills.ts).
create table if not exists custom_skills (
  id text primary key, -- slug kebab-case, ej. "resumen-youtube" (igual formato que los ids fijos)
  label text not null, -- nombre mostrado en el dropdown, ej. "Resumen de YouTube"
  prompt text not null, -- instrucción completa inyectada como preamble (mismo rol que SKILL_PROMPTS[id])
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table custom_skills enable row level security;

-- Sin políticas de usuario (bypass con service-role key desde el backend,
-- igual que el resto de tablas internas de esta instancia) — la tabla no se
-- expone directo a un cliente anon.
