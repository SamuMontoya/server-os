-- Hermes OS · migración 030 — Índice vectorial de documentos de Google Drive
-- Objetivo: que los syllabus/planes de curso de la carpeta compartida de Drive
-- sean buscables semánticamente junto con memorias, reuniones, ejecuciones,
-- conversaciones y vault (match_knowledge), igual patrón que vault_docs (009).
--
-- La VERDAD sigue siendo el archivo en Drive; esta tabla es el índice
-- semántico del texto extraído (PDF/DOCX/XLSX → texto plano). Sync por hash:
-- solo se re-embebe lo que cambió.

create table if not exists drive_docs (
  id bigint generated always as identity primary key,
  -- ID del archivo en Google Drive (o del shortcut resuelto). Único: un doc = una fila.
  drive_file_id text not null unique,
  name text not null,
  mime_type text,
  web_view_link text,
  -- Carpeta raíz de Drive desde la que se sincronizó (permite re-sync/limpieza
  -- acotada por carpeta cuando hay varias fuentes indexadas a la vez).
  source_folder_id text,
  -- Texto extraído (recortado; el embedding trunca a 8000 chars igual que vault_docs).
  content text not null,
  -- sha1 del contenido extraído: si no cambió, no se re-embebe.
  content_hash text not null,
  embedding vector(1536),
  embedding_local vector(768),
  synced_at timestamptz default now()
);

create index if not exists drive_docs_embedding_idx
  on drive_docs using hnsw (embedding vector_cosine_ops);
create index if not exists drive_docs_embedding_local_idx
  on drive_docs using hnsw (embedding_local vector_cosine_ops);
create index if not exists drive_docs_source_folder_idx
  on drive_docs (source_folder_id);

alter table drive_docs enable row level security;

-- ── match_knowledge: agrega la fuente 'drive' ──────────────────────────
-- Mismos pesos que 'vault' (85% similitud + 15% frescura de sync, 365 días):
-- contenido académico, casi atemporal.
create or replace function match_knowledge(
  query_embedding vector(1536),
  match_count int default 12,
  filter_sources text[] default null,
  filter_project text default null
)
returns table (
  source text,
  ref text,
  title text,
  content text,
  project_slug text,
  created_at timestamptz,
  similarity float,
  score float
)
language sql stable
as $$
  with hits as (
    (
      select
        'memory'::text as source,
        m.id::text as ref,
        coalesce(m.summary, left(m.content, 120)) as title,
        m.content,
        m.project_slug,
        m.created_at,
        1 - (m.embedding <=> query_embedding) as similarity,
        (1 - (m.embedding <=> query_embedding)) * 0.70
          + greatest(0, 1 - extract(epoch from (now() - m.created_at)) / (90*24*3600)) * 0.15
          + (coalesce(m.importance, 3) / 5.0) * 0.15 as score
      from memories m
      where m.embedding is not null
        and (filter_sources is null or 'memory' = any(filter_sources))
        and (filter_project is null or m.project_slug = filter_project)
      order by m.embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'meeting',
        mt.meeting_id,
        mt.title,
        coalesce(mt.summary, ''),
        mt.project_slug,
        mt.meeting_date,
        1 - (mt.summary_embedding <=> query_embedding),
        (1 - (mt.summary_embedding <=> query_embedding)) * 0.80
          + greatest(0, 1 - extract(epoch from (now() - mt.meeting_date)) / (180*24*3600)) * 0.20
      from meetings mt
      where mt.summary_embedding is not null
        and (filter_sources is null or 'meeting' = any(filter_sources))
        and (filter_project is null or mt.project_slug = filter_project)
      order by mt.summary_embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'execution',
        te.execution_id,
        coalesce(left(te.prompt, 120), 'ejecución'),
        coalesce(te.analysis, '') || E'\n' || coalesce(te.result, ''),
        te.project_slug,
        te.created_at,
        1 - (te.embedding <=> query_embedding),
        (1 - (te.embedding <=> query_embedding)) * 0.80
          + greatest(0, 1 - extract(epoch from (now() - te.created_at)) / (120*24*3600)) * 0.20
      from task_executions te
      where te.embedding is not null
        and (filter_sources is null or 'execution' = any(filter_sources))
        and (filter_project is null or te.project_slug = filter_project)
      order by te.embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'conversation',
        cm.id::text,
        cm.role || ' · ' || cm.project_slug || case when cm.channel = 'voice' then ' (voz)' else '' end,
        cm.content,
        cm.project_slug,
        cm.ts,
        1 - (cm.embedding <=> query_embedding),
        (1 - (cm.embedding <=> query_embedding)) * 0.75
          + greatest(0, 1 - extract(epoch from (now() - cm.ts)) / (60*24*3600)) * 0.25
      from conversation_messages cm
      where cm.embedding is not null
        and (filter_sources is null or 'conversation' = any(filter_sources))
        and (filter_project is null or cm.project_slug = filter_project)
      order by cm.embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'vault',
        vd.path,
        vd.title,
        vd.content,
        vd.project_slug,
        vd.updated_at,
        1 - (vd.embedding <=> query_embedding),
        (1 - (vd.embedding <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - vd.updated_at)) / (365*24*3600)) * 0.15
      from vault_docs vd
      where vd.embedding is not null
        and (filter_sources is null or 'vault' = any(filter_sources))
        and (filter_project is null or vd.project_slug = filter_project)
      order by vd.embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'drive',
        dd.drive_file_id,
        dd.name,
        dd.content,
        null::text,
        dd.synced_at,
        1 - (dd.embedding <=> query_embedding),
        (1 - (dd.embedding <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - dd.synced_at)) / (365*24*3600)) * 0.15
      from drive_docs dd
      where dd.embedding is not null
        and (filter_sources is null or 'drive' = any(filter_sources))
        and (filter_project is null) -- drive_docs no tiene project_slug propio
      order by dd.embedding <=> query_embedding
      limit match_count
    )
  )
  select h.source, h.ref, h.title, h.content, h.project_slug, h.created_at, h.similarity, h.score
  from (
    select hits.*,
      row_number() over (partition by hits.source order by hits.score desc) as source_rank
    from hits
  ) h
  where h.source_rank <= greatest(2, match_count / 2)
  order by h.score desc
  limit match_count;
$$;

-- ── match_knowledge_local: espejo con embedding_local (768 dims, Ollama) ──
create or replace function match_knowledge_local(
  query_embedding vector(768),
  match_count int default 12,
  filter_sources text[] default null,
  filter_project text default null
)
returns table (
  source text,
  ref text,
  title text,
  content text,
  project_slug text,
  created_at timestamptz,
  similarity float,
  score float
)
language sql stable
as $$
  with hits as (
    (
      select
        'memory'::text as source,
        m.id::text as ref,
        coalesce(m.summary, left(m.content, 120)) as title,
        m.content,
        m.project_slug,
        m.created_at,
        1 - (m.embedding_local <=> query_embedding) as similarity,
        (1 - (m.embedding_local <=> query_embedding)) * 0.70
          + greatest(0, 1 - extract(epoch from (now() - m.created_at)) / (90*24*3600)) * 0.15
          + (coalesce(m.importance, 3) / 5.0) * 0.15 as score
      from memories m
      where m.embedding_local is not null
        and (filter_sources is null or 'memory' = any(filter_sources))
        and (filter_project is null or m.project_slug = filter_project)
      order by m.embedding_local <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'meeting',
        mt.meeting_id,
        mt.title,
        coalesce(mt.summary, ''),
        mt.project_slug,
        mt.meeting_date,
        1 - (mt.summary_embedding_local <=> query_embedding),
        (1 - (mt.summary_embedding_local <=> query_embedding)) * 0.80
          + greatest(0, 1 - extract(epoch from (now() - mt.meeting_date)) / (180*24*3600)) * 0.20
      from meetings mt
      where mt.summary_embedding_local is not null
        and (filter_sources is null or 'meeting' = any(filter_sources))
        and (filter_project is null or mt.project_slug = filter_project)
      order by mt.summary_embedding_local <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'execution',
        te.execution_id,
        coalesce(left(te.prompt, 120), 'ejecución'),
        coalesce(te.analysis, '') || E'\n' || coalesce(te.result, ''),
        te.project_slug,
        te.created_at,
        1 - (te.embedding_local <=> query_embedding),
        (1 - (te.embedding_local <=> query_embedding)) * 0.80
          + greatest(0, 1 - extract(epoch from (now() - te.created_at)) / (120*24*3600)) * 0.20
      from task_executions te
      where te.embedding_local is not null
        and (filter_sources is null or 'execution' = any(filter_sources))
        and (filter_project is null or te.project_slug = filter_project)
      order by te.embedding_local <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'conversation',
        cm.id::text,
        cm.role || ' · ' || cm.project_slug || case when cm.channel = 'voice' then ' (voz)' else '' end,
        cm.content,
        cm.project_slug,
        cm.ts,
        1 - (cm.embedding_local <=> query_embedding),
        (1 - (cm.embedding_local <=> query_embedding)) * 0.75
          + greatest(0, 1 - extract(epoch from (now() - cm.ts)) / (60*24*3600)) * 0.25
      from conversation_messages cm
      where cm.embedding_local is not null
        and (filter_sources is null or 'conversation' = any(filter_sources))
        and (filter_project is null or cm.project_slug = filter_project)
      order by cm.embedding_local <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'vault',
        vd.path,
        vd.title,
        vd.content,
        vd.project_slug,
        vd.updated_at,
        1 - (vd.embedding_local <=> query_embedding),
        (1 - (vd.embedding_local <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - vd.updated_at)) / (365*24*3600)) * 0.15
      from vault_docs vd
      where vd.embedding_local is not null
        and (filter_sources is null or 'vault' = any(filter_sources))
        and (filter_project is null or vd.project_slug = filter_project)
      order by vd.embedding_local <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'drive',
        dd.drive_file_id,
        dd.name,
        dd.content,
        null::text,
        dd.synced_at,
        1 - (dd.embedding_local <=> query_embedding),
        (1 - (dd.embedding_local <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - dd.synced_at)) / (365*24*3600)) * 0.15
      from drive_docs dd
      where dd.embedding_local is not null
        and (filter_sources is null or 'drive' = any(filter_sources))
        and (filter_project is null)
      order by dd.embedding_local <=> query_embedding
      limit match_count
    )
  )
  select h.source, h.ref, h.title, h.content, h.project_slug, h.created_at, h.similarity, h.score
  from (
    select hits.*,
      row_number() over (partition by hits.source order by hits.score desc) as source_rank
    from hits
  ) h
  where h.source_rank <= greatest(2, match_count / 2)
  order by h.score desc
  limit match_count;
$$;
