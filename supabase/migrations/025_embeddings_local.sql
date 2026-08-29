-- server-os · migración 025 — Embeddings locales (768 dims) en paralelo
--
-- Por qué existe: el cerebro corre en un servidor sin key de OpenAI y genera
-- sus embeddings con Ollama (nomic-embed-text, 768 dims). El esquema original
-- es vector(1536) de text-embedding-3-small y esta base la COMPARTE con el
-- hermes-os de la Mac.
--
-- Por eso la migración es ADITIVA, no una conversión: se agregan columnas y
-- RPCs `_local` al lado de las de 1536, que quedan intactas. hermes-os sigue
-- funcionando exactamente igual; server-os usa las nuevas. Las dos memorias
-- conviven en las mismas filas — una fila puede tener uno, otro o ambos.
--
-- pgvector NO permite comparar vectores de distinta dimensión, así que cada
-- ruta busca solo dentro de su propia columna. Un recuerdo escrito por el
-- servidor no es visible a la búsqueda semántica de la Mac (y viceversa)
-- hasta que se reindexe con el otro modelo.

-- ── 1) Columnas paralelas ─────────────────────────────────────────────
alter table memories              add column if not exists embedding_local vector(768);
alter table meetings              add column if not exists summary_embedding_local vector(768);
alter table task_executions       add column if not exists embedding_local vector(768);
alter table conversation_messages add column if not exists embedding_local vector(768);
alter table vault_docs            add column if not exists embedding_local vector(768);

-- ── 2) Índices HNSW, uno por columna nueva ────────────────────────────
create index if not exists memories_embedding_local_idx
  on memories using hnsw (embedding_local vector_cosine_ops);
create index if not exists meetings_embedding_local_idx
  on meetings using hnsw (summary_embedding_local vector_cosine_ops);
create index if not exists task_executions_embedding_local_idx
  on task_executions using hnsw (embedding_local vector_cosine_ops);
create index if not exists conversation_messages_embedding_local_idx
  on conversation_messages using hnsw (embedding_local vector_cosine_ops);
create index if not exists vault_docs_embedding_local_idx
  on vault_docs using hnsw (embedding_local vector_cosine_ops);

-- ── 3) match_memories_local ───────────────────────────────────────────
-- Mismos pesos que la de 1536: 70% similitud + 15% recencia + 15% importancia.
create or replace function match_memories_local(
  query_embedding vector(768),
  match_count int default 8,
  filter_type text default null
)
returns table (
  id uuid,
  type text,
  content text,
  summary text,
  project_slug text,
  tags text[],
  importance smallint,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    m.id, m.type, m.content, m.summary, m.project_slug, m.tags,
    m.importance, m.created_at,
    1 - (m.embedding_local <=> query_embedding) as similarity
  from memories m
  where m.embedding_local is not null
    and (filter_type is null or m.type = filter_type)
  order by
    (1 - (m.embedding_local <=> query_embedding)) * 0.70
    + greatest(0, 1 - extract(epoch from (now() - m.created_at)) / (90*24*3600)) * 0.15
    + (coalesce(m.importance, 3) / 5.0) * 0.15
    desc
  limit match_count;
$$;

-- ── 4) match_meetings_local ───────────────────────────────────────────
create or replace function match_meetings_local(
  query_embedding vector(768),
  match_count int default 6
)
returns table (
  meeting_id text,
  title text,
  summary text,
  project_slug text,
  meeting_date timestamptz,
  similarity float
)
language sql stable
as $$
  select
    mt.meeting_id, mt.title, mt.summary, mt.project_slug, mt.meeting_date,
    1 - (mt.summary_embedding_local <=> query_embedding) as similarity
  from meetings mt
  where mt.summary_embedding_local is not null
  order by mt.summary_embedding_local <=> query_embedding
  limit match_count;
$$;

-- ── 5) match_knowledge_local ──────────────────────────────────────────
-- Espejo exacto de match_knowledge (010), incluida la regla de diversidad:
-- ninguna fuente ocupa más de la mitad del resultado (mínimo 2).
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
