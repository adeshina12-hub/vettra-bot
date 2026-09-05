-- Run this once in your Supabase project's SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)

create table if not exists raw_signals (
  id text primary key,
  source text not null,
  sub_source text not null,
  asset text,
  title text not null,
  detail text not null,
  url text,
  metric_value double precision,
  metric_label text,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists opportunities (
  id text primary key,
  title text not null,
  asset text,
  score double precision not null,
  reasoning text not null,
  supporting_signal_ids jsonb not null default '[]',
  category text not null,
  created_at timestamptz not null,
  alerted boolean not null default false
);

create index if not exists opportunities_alerted_score_idx
  on opportunities (alerted, score desc);

create index if not exists opportunities_created_at_idx
  on opportunities (created_at desc);

-- Rolling history of per-run mention/post counts per watch term, used to
-- detect velocity spikes (a jump vs. recent baseline) rather than raw
-- counts, which are meaningless without context.
create table if not exists term_mention_history (
  id bigint generated always as identity primary key,
  term text not null,
  count integer not null,
  recorded_at timestamptz not null default now()
);

create index if not exists term_mention_history_term_recorded_idx
  on term_mention_history (term, recorded_at desc);

-- Optional housekeeping: keep only the most recent 200 rows per term.
-- Run manually now and then, or set up as a Supabase scheduled Edge
-- Function / pg_cron job later — not required for the pipeline to work.
-- delete from term_mention_history t
-- where id not in (
--   select id from (
--     select id, row_number() over (partition by term order by recorded_at desc) as rn
--     from term_mention_history
--   ) ranked where rn <= 200
-- );

-- Row Level Security: left OFF for now since this pipeline writes with the
-- service role key, which bypasses RLS entirely. Turn RLS on and add
-- per-user policies when you add auth and open the dashboard to other users.

-- Due-diligence research reports. profile/criteria/model_agreement are
-- stored as jsonb since their shape is defined in TypeScript (ProjectProfile,
-- CriterionResult[], ModelAgreement) rather than needing separate columns.
create table if not exists reports (
  id text primary key,
  query text not null,
  query_normalized text,
  profile jsonb not null,
  criteria jsonb not null,
  overall_score double precision not null,
  verdict text not null,
  strengths jsonb not null default '[]',
  red_flags jsonb not null default '[]',
  model_agreement jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reports_created_at_idx on reports (created_at desc);
create index if not exists reports_query_idx on reports (query);
alter table reports add column if not exists query_normalized text;
create index if not exists reports_query_normalized_idx on reports (query_normalized, created_at desc);

-- Telegram bot analytics, quotas, and provider budget reservations.
create table if not exists bot_users (
  telegram_user_id bigint primary key,
  username text,
  display_name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists bot_research_events (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  query_normalized text not null,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists bot_research_events_created_at_idx
  on bot_research_events (created_at desc);
create index if not exists bot_research_events_query_idx
  on bot_research_events (query_normalized, created_at desc);

create table if not exists llm_usage_reservations (
  id bigint generated always as identity primary key,
  provider text not null,
  estimated_cost_usd numeric(12, 6) not null,
  created_at timestamptz not null default now()
);

create index if not exists llm_usage_reservations_created_at_idx
  on llm_usage_reservations (created_at desc);

create or replace function reserve_llm_budget(
  requested_provider text,
  requested_cost_usd numeric,
  daily_cap_usd numeric
) returns boolean
language plpgsql
as $$
declare
  current_spend numeric;
begin
  perform pg_advisory_xact_lock(hashtext('vettra-llm-daily-budget'));
  select coalesce(sum(estimated_cost_usd), 0) into current_spend
  from llm_usage_reservations
  where created_at >= date_trunc('day', now());

  if current_spend + requested_cost_usd > daily_cap_usd then
    return false;
  end if;

  insert into llm_usage_reservations(provider, estimated_cost_usd)
  values (requested_provider, requested_cost_usd);
  return true;
end;
$$;

create or replace function claim_bot_research(
  requested_user_id bigint,
  requested_query text,
  daily_limit integer
) returns boolean
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('vettra-bot-user-' || requested_user_id::text));
  if (
    select count(*) from bot_research_events
    where telegram_user_id = requested_user_id
      and created_at >= date_trunc('day', now())
  ) >= daily_limit then
    return false;
  end if;

  insert into bot_research_events(telegram_user_id, query_normalized, cached)
  values (requested_user_id, requested_query, false);
  return true;
end;
$$;
