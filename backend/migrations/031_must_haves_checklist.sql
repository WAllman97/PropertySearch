-- Run once in the Supabase SQL editor (after 030).
--
-- A household's must-haves (their dealbreaker list), set once in Settings,
-- and each home's ticks against it, made while viewing. Ticks live with the
-- home's other notes (property_notes), keyed by must-have id:
--   {"<must_have id>": "yes" | "no"}   (missing = not checked yet)
-- The free-text viewing notes already have a column (viewing_notes).

create table if not exists must_haves (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id()
    references households (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 80),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists must_haves_household_idx on must_haves (household_id, position);

alter table must_haves enable row level security;

drop policy if exists household_must_haves on must_haves;
create policy household_must_haves on must_haves for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

alter table property_notes
  add column if not exists checklist jsonb not null default '{}'::jsonb;

-- Check: should return 1 row (must_haves) and 1 row (checklist).
select 'must_haves' as made from information_schema.tables where table_name = 'must_haves'
union all
select 'checklist' from information_schema.columns
where table_name = 'property_notes' and column_name = 'checklist';
