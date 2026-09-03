-- Continuidad de chat entre dispositivos: hoy los "chats" del Laboratorio
-- viven SOLO en localStorage del navegador (lib/lab-persist.ts) — abrir la
-- misma cuenta desde otro dispositivo no ve nada. Esta tabla es un espejo
-- server-side, scoped por usuario (auth.users.id, el mismo que ya resuelve
-- el JWT de Supabase en cada request al agente), para que el agente pueda
-- servir "los mismos chats" sin importar desde qué Mac/iPhone se abra el
-- portal. Solo el agente escribe (service_role, mismo patrón que el resto
-- del repo) — RLS deny-all, sin policies.
create table if not exists chat_threads (
  id text not null,
  user_id uuid not null,
  project text not null default 'general',
  session_key text not null default '',
  sdk_session_id text,
  title text,
  messages jsonb not null default '[]'::jsonb,
  draft text not null default '',
  model text,
  pending_turn jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists chat_threads_user_project_idx
  on chat_threads (user_id, project, updated_at desc);
alter table chat_threads enable row level security;

-- Qué chat retoma cada usuario al volver, por proyecto — el equivalente
-- server-side de `activeByProject` en lab-persist.ts.
create table if not exists chat_active_chat (
  user_id uuid not null,
  project text not null,
  chat_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, project)
);
alter table chat_active_chat enable row level security;
