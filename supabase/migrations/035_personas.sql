-- Épica H (MVP 6): Personas/"sombreritos" — identidades completas y persistentes
-- con su propio historial de chats, preamble base, y opcionalmente skill por defecto.
--
-- Modelo: una persona agrupa un conjunto de chats (como `project` hoy, pero para
-- identidad en vez de dominio). Samu es el único usuario, así que sin scoping por
-- user_id (igual que watch_link, feedback, etc.) — una fila = una persona
-- disponible para activar desde PersonaSelector.
--
-- Historial migrado de Perplexity u otra fuente: se importa como documento
-- adjunto inicial a la persona vía el pipeline de attachments existente
-- (read_chat_document), no se construye un scraper — es fuera de alcance y frágil.

create table if not exists personas (
  id text primary key, -- slug kebab-case, ej. "doctor" (mismo patrón que custom_skills)
  label text not null, -- nombre mostrado en selector, ej. "Doctor"
  avatar_emoji_or_url text, -- emoji (ej. "🏥") o URL de imagen pequeña para el chip
  preamble_base text not null, -- preamble inyectado SIEMPRE que esta persona esté activa (identidad persistente)
  default_skill_id text, -- FK opcional a custom_skills.id o uno de los 8 ids fijos (auto-select al activar persona)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table personas enable row level security;

-- FK opcional a custom_skills (puede ser null si no hay skill por defecto, o
-- apuntar a un skill inexistente tras borrarlo — se valida en la app, no en la
-- DB, porque los 8 ids fijos no viven en una tabla).
-- Aquí NOT added intencionalmente: las personas pueden existir aunque el skill
-- de referencia desaparezca (fallback a "sin skill" en el frontend).

-- Vincular chats a personas (igual que hoy están vinculados a project):
alter table chat_threads add column persona_id text references personas(id) on delete set null;
-- Índice para filtrar chats por persona activa
create index if not exists idx_chat_threads_persona_id on chat_threads(persona_id);
