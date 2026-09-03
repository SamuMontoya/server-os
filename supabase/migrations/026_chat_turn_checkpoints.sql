-- Checkpoint de turnos de chat EN VUELO, para sobrevivir un reinicio del
-- agente (deploy, OOM del cgroup) a mitad de una respuesta.
--
-- El motor de turnos (agent/chat-turns.ts) vive enteramente en memoria de
-- proceso — Maps de turns/events/subs — y solo persistía al CERRAR un turno
-- normalmente (`close()` → `appendTurn`). Si el proceso moría a mitad de
-- `drive()`, el texto ya generado (a veces la respuesta casi completa) y el
-- mensaje del usuario se perdían sin dejar rastro server-side: el cliente lo
-- detectaba bien (404 → "el turno se perdió al reiniciarse el agente"), pero
-- no había nada que recuperar. El tracker de tareas (/tracker/*) ya tenía
-- `reconcileRunningTasks()` para este mismo problema; el chat nunca lo tuvo.
--
-- Esta tabla es un checkpoint de "mejor esfuerzo": se escribe periódicamente
-- mientras el turno corre (no en cada delta — eso sería un write por token) y
-- se BORRA en cuanto el turno cierra normalmente. Si al arrancar el agente
-- encuentra filas aquí, son turnos que quedaron huérfanos de un proceso
-- anterior: `reconcileChatTurns()` (index.ts, junto a reconcileRunningTasks)
-- los persiste a `conversations` como respuesta parcial con nota de que se
-- interrumpió, y limpia la fila.
create table if not exists chat_turn_checkpoints (
  id text primary key,                 -- turn.id (uuid del motor)
  session_key text not null,           -- tab que lo disparó
  project text not null default 'general',
  prompt text not null,
  text text not null default '',       -- acumulado hasta el último checkpoint
  sdk_session_id text,                 -- se sabe apenas el SDK lo anuncia
  attempts int not null default 1,
  machine text,                        -- qué agente lo estaba corriendo
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_turn_checkpoints_updated_idx
  on chat_turn_checkpoints (updated_at);

-- Solo el agente (service_role, bypassa RLS) toca esta tabla — no es un dato
-- que el dashboard deba leer nunca directo, es un detalle de recuperación
-- interna. RLS habilitado sin políticas = deny-all para anon/authenticated.
alter table chat_turn_checkpoints enable row level security;
