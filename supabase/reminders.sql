-- BusyNes daily reminders. Run once in the Supabase SQL Editor, AFTER schema.sql.
-- Every morning (06:00 UTC = 08:00 in South Africa) it tells whoever is collecting an unpaid
-- balance when it is due in 2 days, due today, or overdue (repeated every 3 days).
-- Uses pg_cron, which is included on the free plan.
create extension if not exists pg_cron;

select cron.schedule(
  'busynes-due-reminders',
  '0 6 * * *',
  $$ select busynes.send_due_reminders(); $$
);

-- To stop the reminders later:  select cron.unschedule('busynes-due-reminders');
-- To try it right now:          select busynes.send_due_reminders();
