-- Persistencia del "chat vinculado al reloj" (ver apps/agent/src/watch/active-link.ts).
-- Antes vivía SOLO en memoria del proceso (variable `actual`), con vida de 2h
-- y sin sobrevivir a un reinicio del agente — por eso Samu seguía viendo
-- respuestas del reloj después de pensar que lo había "apagado": el vínculo
-- efímero seguía activo aunque el usuario esperara que se hubiera perdido.
-- Samu es el único usuario de esta instancia, así que UNA fila fija basta
-- (sin scoping por user_id, sin tabla de "chats" — el reloj sigue un turno,
-- no un thread completo).
create table if not exists watch_link (
  id boolean primary key default true,
  turn_id text,
  title text,
  linked_at timestamptz,
  constraint watch_link_single_row check (id)
);
alter table watch_link enable row level security;
