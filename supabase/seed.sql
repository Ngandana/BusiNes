-- This file is no longer needed.
--
-- Before version 3, BusyNes was set up for three fixed partners with this file.
-- Now anyone can create their own business inside the app (sign up, then "Create my business"),
-- invite their partners by email, and set who owns what under Business settings.
--
-- If you are upgrading an old single-business database, just run schema.sql: it turns the
-- existing partners, products and sales into the first business automatically.
-- (A copy of the old seed, with example emails, is kept in tests/fixtures for the upgrade test.)
select 'seed.sql is not used any more' as note;
