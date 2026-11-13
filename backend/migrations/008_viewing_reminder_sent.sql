-- Viewing reminders: run once in the Supabase SQL editor.
--
-- jobs/send_viewing_reminders.py (hourly GitHub Action) records when it has
-- emailed the day-before reminder, so each viewing gets exactly one. The
-- column was never created, so every run failed on its first query.

alter table property_notes
  add column if not exists reminder_sent_at timestamptz;

-- A viewing that is moved or rebooked needs a fresh reminder for the new
-- time, so clear the marker whenever viewing_datetime changes.
create or replace function reset_viewing_reminder()
returns trigger
language plpgsql
as $$
begin
  if new.viewing_datetime is distinct from old.viewing_datetime then
    new.reminder_sent_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists property_notes_reset_reminder on property_notes;
create trigger property_notes_reset_reminder
  before update on property_notes
  for each row execute function reset_viewing_reminder();
