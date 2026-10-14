-- MVP 8, K1 (monitoreo de consumo) — pedido de Jaime 2026-10-14: "arma uno
-- basado en anthropic, con métricas propias también del correo que lo usa".
--
-- getClaudeUsage() (claude-usage.ts) ya agrega tokens/costo REALES leyendo
-- ~/.claude/projects/*.jsonl (fuente de verdad de Anthropic) — eso cubre
-- "basado en anthropic". Lo que faltaba es el "del correo que lo usa": esos
-- JSONL no saben qué persona disparó cada turno. Esta tabla cierra ese hueco
-- guardando, por turno, quién lo pidió — así se puede cruzar "cuánto cuesta"
-- con "quién lo gastó" sin tocar la fuente de Anthropic.
--
-- `user_email` viene del BODY del POST /chat/turns (ver routes/chat.ts), no
-- del JWT verificado de Supabase: jaime-os (la app real que se usa a diario)
-- autentica contra el agente con el HERMES_API_KEY estático compartido, no
-- con un JWT por persona — el middleware de userId/userEmail verificado
-- (auth.ts) solo se activa para la app móvil. Para ESTE propósito (atribuir
-- consumo, no autorizar nada) basta con el correo que ya conoce el cliente
-- vía su propia sesión de Supabase (useCurrentUser()) — no es un límite de
-- seguridad, es una etiqueta de reporte.
create table if not exists turn_usage (
  id uuid primary key default gen_random_uuid(),
  -- Null = turno sin email (HERMES_API_KEY sin cliente nuevo desplegado
  -- todavía, o reloj/automatización) — no se descarta, cae a "sin atribuir"
  -- en el reporte en vez de perderse.
  user_email text,
  project text,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);
alter table turn_usage enable row level security;

-- Sin políticas de usuario (bypass con service-role key desde el backend,
-- igual que custom_skills/personas) — nunca se expone directo a un cliente.

create index if not exists turn_usage_email_idx on turn_usage (user_email, created_at desc);
create index if not exists turn_usage_created_idx on turn_usage (created_at desc);
