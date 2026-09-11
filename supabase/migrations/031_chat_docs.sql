-- Hermes OS · migración 031 — Documentos subidos a mano en el chat (el clip)
-- Objetivo: separar "lo que Jaime sube a mano en el composer" de "lo que se
-- scrapeó de Drive" (drive_docs, migración 030). Misma idea de fondo (texto
-- extraído + vector, buscable por match_knowledge) pero tabla propia: el
-- origen importa (Jaime pidió explícitamente no mezclarlos) y el shape es
-- distinto — un archivo grande puede partirse en VARIOS fragmentos (chunks),
-- cosa que drive_docs no necesita porque trunca a 16k chars.
--
-- El archivo original NUNCA toca disco: se procesa en memoria y se descarta.
-- Solo vive el texto extraído (por fragmento) y su vector.

create table if not exists chat_docs (
  id bigint generated always as identity primary key,
  -- Agrupa los fragmentos de UN mismo archivo subido (varias filas comparten doc_id).
  doc_id uuid not null,
  chunk_index int not null default 0,
  chunk_count int not null default 1,
  name text not null,
  mime_type text,
  content text not null,
  content_hash text not null,
  embedding vector(1536),
  embedding_local vector(768),
  created_at timestamptz default now(),
  unique (doc_id, chunk_index)
);

create index if not exists chat_docs_doc_id_idx on chat_docs (doc_id);
create index if not exists chat_docs_embedding_idx
  on chat_docs using hnsw (embedding vector_cosine_ops);
create index if not exists chat_docs_embedding_local_idx
  on chat_docs using hnsw (embedding_local vector_cosine_ops);

alter table chat_docs enable row level security;

-- ── match_knowledge: agrega la fuente 'chat' ───────────────────────────
-- Mismos pesos que 'drive'/'vault' (85% similitud + 15% frescura, 365 días).
-- `ref` incluye el índice de fragmento (un doc_id puede tener varias filas);
-- `title` avisa "(fragmento i/n)" cuando el archivo se partió en más de uno.
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
        and (filter_project is null)
      order by dd.embedding <=> query_embedding
      limit match_count
    )
    union all
    (
      select
        'chat',
        cd.doc_id::text || ':' || cd.chunk_index::text,
        case when cd.chunk_count > 1
          then cd.name || ' (fragmento ' || (cd.chunk_index + 1)::text || '/' || cd.chunk_count::text || ')'
          else cd.name
        end,
        cd.content,
        null::text,
        cd.created_at,
        1 - (cd.embedding <=> query_embedding),
        (1 - (cd.embedding <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - cd.created_at)) / (365*24*3600)) * 0.15
      from chat_docs cd
      where cd.embedding is not null
        and (filter_sources is null or 'chat' = any(filter_sources))
        and (filter_project is null)
      order by cd.embedding <=> query_embedding
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
    union all
    (
      select
        'chat',
        cd.doc_id::text || ':' || cd.chunk_index::text,
        case when cd.chunk_count > 1
          then cd.name || ' (fragmento ' || (cd.chunk_index + 1)::text || '/' || cd.chunk_count::text || ')'
          else cd.name
        end,
        cd.content,
        null::text,
        cd.created_at,
        1 - (cd.embedding_local <=> query_embedding),
        (1 - (cd.embedding_local <=> query_embedding)) * 0.85
          + greatest(0, 1 - extract(epoch from (now() - cd.created_at)) / (365*24*3600)) * 0.15
      from chat_docs cd
      where cd.embedding_local is not null
        and (filter_sources is null or 'chat' = any(filter_sources))
        and (filter_project is null)
      order by cd.embedding_local <=> query_embedding
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
