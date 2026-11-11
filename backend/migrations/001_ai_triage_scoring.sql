-- AI triage scoring: run once in the Supabase SQL editor.
--
-- description    listing summary + key features captured by the scraper
-- ai_scores      Claude's proposal: {location: {score, reason}, ..., summary, red_flags}
-- ai_model       model that produced ai_scores
-- ai_scored_at   when it was scored (NULL = not scored yet)
-- scores_source  'ai' while the score_* columns hold Claude's proposal,
--                'manual' once you save scores yourself (AI never overwrites those)

alter table properties add column if not exists description text;
alter table properties add column if not exists ai_scores jsonb;
alter table properties add column if not exists ai_model text;
alter table properties add column if not exists ai_scored_at timestamptz;
alter table properties add column if not exists scores_source text;

-- Scores saved before this change were entered by hand.
update properties
set scores_source = 'manual'
where scores_source is null
  and overall_score is not null;
