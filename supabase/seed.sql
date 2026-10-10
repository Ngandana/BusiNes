-- BusyNes starting data. Run after schema.sql.
-- 1. Replace the three email addresses below with the ones each partner will sign in with.
-- 2. Run the whole file in Supabase: SQL Editor > New query > paste > Run.

set search_path = busynes;

insert into partners (id, name, email) values
  ('sibabalo', 'Sibabalo', 'sibabalo@example.com'),
  ('vusi',     'Vusi',     'vusi@example.com'),
  ('dokotela', 'Dokotela', 'dokotela@example.com')
on conflict (id) do update set name = excluded.name, email = excluded.email;

-- Sibabalo owns his products outright. Vusi and Dokotela share the beers 50/50.
insert into owner_shares (owner, partner_id, share) values
  ('sibabalo', 'sibabalo', 1),
  ('beers',    'vusi',     0.5),
  ('beers',    'dokotela', 0.5)
on conflict (owner, partner_id) do update set share = excluded.share;

insert into products (id, name, price, owner, sort) values
  ('first-watch',         'First Watch Whisky',     250, 'sibabalo', 1),
  ('gordons',             'Gordon''s Gin',          280, 'sibabalo', 2),
  ('russian-bear',        'Russian Bear Vodka',     270, 'sibabalo', 3),
  ('robertson-sweet-red', 'Robertson''s Sweet Red',  75, 'sibabalo', 4),
  ('robertson-dry-red',   'Robertson''s Dry Red',    75, 'sibabalo', 5),
  ('savanna',             'Savanna',                 40, 'sibabalo', 6),
  ('nini-mimosa',         'Nini Mimosa',             35, 'sibabalo', 7),
  ('heineken',            'Heineken',                40, 'beers',    1),
  ('black-label',         'Black Label',             35, 'beers',    2),
  ('stella-artois',       'Stella Artois',           40, 'beers',    3)
on conflict (id) do nothing;
