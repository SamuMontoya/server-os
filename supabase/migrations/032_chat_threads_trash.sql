-- Papelera de chats (pedido de Jaime 2026-09-16): borrar un chat del
-- Laboratorio ya no es un DELETE físico — pasa a "trashed" y vive ahí 30
-- días con opción de restaurar, antes de purgarse solo (ver
-- purgeExpiredTrashedThreads en chat-threads.ts + el job "chat-trash-purge"
-- en index.ts). `status` guarda el estado y `deleted_at` el instante del
-- borrado, que es lo que el job usa para decidir cuándo ya expiró.
alter table chat_threads
  add column if not exists status text not null default 'active',
  add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_threads_status_check'
  ) then
    alter table chat_threads
      add constraint chat_threads_status_check check (status in ('active', 'trashed'));
  end if;
end $$;

-- Impide el estado a medias "trashed sin deleted_at" (o "active con
-- deleted_at colgado"): purgeExpiredTrashedThreads filtra por
-- `deleted_at < cutoff`, y un NULL ahí nunca matchea esa comparación —
-- un chat así quedaría en la papelera para siempre sin que nada lo purgue.
-- El código ya no puede llegar a ese estado (delete/restore siempre setean
-- los dos campos juntos), pero este constraint lo hace imposible también a
-- nivel de fila, sin importar quién escriba.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_threads_trash_consistency_check'
  ) then
    alter table chat_threads
      add constraint chat_threads_trash_consistency_check
      check ((status = 'trashed') = (deleted_at is not null));
  end if;
end $$;

-- La lista de chats (activos/papelera) filtra por (user_id, project, status)
-- y ordena por updated_at o deleted_at según el caso — cubierto por este
-- índice compuesto.
create index if not exists chat_threads_status_deleted_idx
  on chat_threads (user_id, project, status, deleted_at);

-- El job de purga (purgeExpiredTrashedThreads) corre GLOBAL, sin user_id ni
-- project en el WHERE — el índice de arriba no le sirve porque arranca por
-- user_id. Este índice parcial (solo filas trashed) es el que de verdad usa
-- esa query: `WHERE status = 'trashed' AND deleted_at < cutoff`.
create index if not exists chat_threads_trash_purge_idx
  on chat_threads (deleted_at)
  where status = 'trashed';
