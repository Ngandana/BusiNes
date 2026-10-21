-- BusyNes database setup for Supabase. Version 3: many separate businesses.
-- Run this whole file in Supabase: SQL Editor > New query > paste > Run.
-- It is safe to run again, and it upgrades an older BusyNes database in place:
-- the existing partners, sales and stock become the first business ("BusyNes"),
-- after a private copy is saved to the busynes_backup schema.
--
-- Privacy model
--   * A business is only visible to the people who belong to it (active members).
--     Nobody else can read it through the app or the public API: not other
--     businesses, and not whoever built BusyNes. There is no admin screen.
--   * Roles: owner (runs the business, invites people, sets who owns what),
--     partner (co-owner with a percentage), staff (records sales, orders and stock),
--     delivery (sees and takes orders only).
--   * Inside a business, "private" mode keeps each partner's money details to
--     themselves (the original BusyNes behaviour); "shared" mode lets owners and
--     partners see all money details.
--   * Everything is written by functions that check membership and role. The
--     app has read-only access to a few tables and no write access at all.
--   * Money totals come from my_money(), which works out everybody's balance on
--     the server but only returns the caller's own numbers.

-- ---------------------------------------------------------------- schema
-- Everything lives in its own "busynes" schema so this can share a Supabase project
-- with another app without touching its tables, policies or functions.
-- After running this, add "busynes" to Exposed schemas (Project Settings > API).
create schema if not exists busynes;
set search_path = busynes;
-- Safety check: stop immediately if new objects would not land in busynes.
do $$ begin
  if current_schema() <> 'busynes' then raise exception 'search_path is not busynes; aborting'; end if;
end $$;
grant usage on schema busynes to authenticated;

-- ---------------------------------------------------------------- backup before upgrading
-- If this is an older (single-business) database, keep a private copy of every table first.
-- The copy lives in busynes_backup, which is not exposed through the API.
do $$
declare t text;
begin
  if to_regclass('busynes.partners') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'busynes' and table_name = 'partners' and column_name = 'business_id')
     and to_regclass('busynes_backup.partners') is null then
    create schema busynes_backup;
    foreach t in array array['partners','owner_shares','products','stock_moves','sales','sale_items','sale_payments',
                             'settlements','orders','order_fees','notifications','messages','push_subscriptions'] loop
      if to_regclass('busynes.' || t) is not null then
        execute format('create table busynes_backup.%I as table busynes.%I', t, t);
        execute format('alter table busynes_backup.%I enable row level security', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------- tables
create table if not exists businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 60),
  kind       text not null default '',
  privacy    text not null default 'shared' check (privacy in ('shared','private')),
  team_settle boolean not null default false,   -- co-owners of the same stock settle up as one team (e.g. two partners running the beers together)
  created_by uuid,
  created_at timestamptz not null default now()
);

-- People in a business. (Called "partners" for historical reasons; a row is one person in one business.)
create table if not exists partners (
  id    text primary key,                 -- legacy ids ('sibabalo') or generated ('m...')
  name  text not null,
  email text unique                       -- replaced by a per-business unique index below
);

-- Which people own which group of products, and their share of it.
create table if not exists owner_shares (
  owner      text not null,               -- product owner group, e.g. 'sibabalo', 'beers', 'everyone'
  partner_id text not null references partners(id),
  share      numeric(5,4) not null check (share > 0 and share <= 1),
  primary key (owner, partner_id)
);

create table if not exists products (
  id     text primary key,
  name   text not null,
  price  numeric(10,2) not null check (price >= 0),
  owner  text not null,
  sort   int not null default 99,
  hidden boolean not null default false
);

create table if not exists stock_moves (
  id         bigint generated always as identity primary key,
  product_id text not null references products(id),
  kind       text not null check (kind in ('add','count')),  -- delivery, or a stock count
  qty        int  not null check (qty >= 0),
  at         timestamptz not null default now(),
  by         text references partners(id)
);

create table if not exists sales (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  paid_to     text not null references partners(id),
  method      text not null check (method in ('cash','transfer')),
  note        text not null default '',
  recorded_by text not null references partners(id)
);

create table if not exists sale_items (
  id         bigint generated always as identity primary key,
  sale_id    bigint not null references sales(id) on delete cascade,
  product_id text not null references products(id),
  name       text not null,
  owner      text not null,
  price      numeric(10,2) not null,
  qty        int not null check (qty > 0)
);

create table if not exists settlements (
  id  bigint generated always as identity primary key,
  at  timestamptz not null default now(),
  by  text references partners(id)
);

alter table partners add column if not exists phone text;             -- for the Call / WhatsApp buttons
alter table sales    add column if not exists due_on date;            -- when an unpaid balance is promised back
-- A loan fee is what the lender charges on top of the items. It belongs to fee_to, not to the owners of the items.
alter table sales    add column if not exists loan_fee numeric(10,2) not null default 0 check (loan_fee >= 0);
alter table sales    add column if not exists fee_to text references partners(id);

-- Money received against a sale. A sale paid in full has one payment; a sale on credit has
-- less than its total until the customer pays the rest. (Existing sales are backfilled once.)
do $$ begin
  if to_regclass('busynes.sale_payments') is null then
    create table busynes.sale_payments (
      id          bigint generated always as identity primary key,
      sale_id     bigint not null references busynes.sales(id) on delete cascade,
      amount      numeric(10,2) not null check (amount > 0),
      method      text not null check (method in ('cash','transfer')),
      paid_to     text not null references busynes.partners(id),
      recorded_by text not null references busynes.partners(id),
      at          timestamptz not null default now()
    );
    insert into busynes.sale_payments (sale_id, amount, method, paid_to, recorded_by, at)
      select s.id, t.total, s.method, s.paid_to, s.recorded_by, s.at
      from busynes.sales s
      join (select sale_id, sum(price * qty) as total from busynes.sale_items group by sale_id) t on t.sale_id = s.id
      where t.total > 0;
  end if;
end $$;

-- Orders that came in (e.g. from WhatsApp) and are waiting to be sold.
create table if not exists orders (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  customer   text not null default '',
  items      jsonb not null,                       -- [{"product_id","name","qty"}]
  note       text not null default '',
  status     text not null default 'open' check (status in ('open','done','cancelled')),
  created_by text not null references partners(id),
  sale_id    bigint references sales(id) on delete set null
);
alter table orders add column if not exists claimed_by text references partners(id);
alter table orders add column if not exists claimed_at timestamptz;
alter table orders add column if not exists loan boolean not null default false;   -- lent out, to be paid back later
-- The fee for a loan order is the lender's business: only they can read it.
create table if not exists order_fees (
  order_id bigint primary key references orders(id) on delete cascade,
  fee      numeric(10,2) not null check (fee > 0),
  fee_to   text not null references partners(id)
);

-- One row per person to tell. Written only by the functions below, so what each person
-- is told respects the same privacy rules as everything else.
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  partner_id text not null references partners(id),
  at         timestamptz not null default now(),
  kind       text not null,
  title      text not null,
  body       text not null default '',
  ref        text,
  read_at    timestamptz
);

create table if not exists messages (
  id   bigint generated always as identity primary key,
  at   timestamptz not null default now(),
  from_partner text not null references partners(id),
  body text not null check (length(body) between 1 and 500)
);

-- Phones that asked for notifications (Web Push). Never readable from the app directly.
create table if not exists push_subscriptions (
  id         bigint generated always as identity primary key,
  partner_id text references partners(id),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- version 3: columns for many businesses
alter table businesses add column if not exists team_settle boolean not null default false;
alter table partners add column if not exists business_id uuid references businesses(id);
alter table partners add column if not exists user_id uuid;            -- the login (auth user) behind this person
alter table partners add column if not exists role text not null default 'partner' check (role in ('owner','partner','staff','delivery'));
alter table partners add column if not exists status text not null default 'active' check (status in ('active','invited','removed'));
alter table partners add column if not exists created_at timestamptz not null default now();
alter table partners drop constraint if exists partners_email_key;     -- the same email can be in several businesses

alter table owner_shares  add column if not exists business_id uuid references businesses(id);
alter table products      add column if not exists business_id uuid references businesses(id);
alter table products      add column if not exists track_stock boolean not null default true;   -- false for made-to-order items
alter table stock_moves   add column if not exists business_id uuid references businesses(id);
alter table sales         add column if not exists business_id uuid references businesses(id);
alter table sale_items    add column if not exists business_id uuid references businesses(id);
alter table sale_payments add column if not exists business_id uuid references businesses(id);
alter table settlements   add column if not exists business_id uuid references businesses(id);
alter table orders        add column if not exists business_id uuid references businesses(id);
alter table notifications add column if not exists business_id uuid references businesses(id);
alter table messages      add column if not exists business_id uuid references businesses(id);
alter table push_subscriptions add column if not exists user_id uuid;
alter table push_subscriptions alter column partner_id drop not null;

-- Upgrade: everything that exists before version 3 becomes the first business, "BusyNes".
-- The owner is Sibabalo (or the first partner), the others become partners. People are linked to
-- their logins by email; anyone who has not signed up yet is "invited" and joins when they do.
do $$
declare biz uuid; owner_id text; owner_uid uuid;
begin
  if exists (select 1 from partners where business_id is null) then
    select id into owner_id from partners where business_id is null order by (id = 'sibabalo') desc, id limit 1;
    select u.id into owner_uid from partners p join auth.users u on lower(u.email) = lower(p.email) where p.id = owner_id limit 1;
    insert into businesses (name, kind, privacy, team_settle, created_by) values ('BusyNes', 'Drinks', 'private', true, owner_uid) returning id into biz;
    update partners set business_id = biz where business_id is null;
    update partners p set user_id = u.id
      from auth.users u
      where lower(u.email) = lower(p.email) and u.email_confirmed_at is not null and p.business_id = biz and p.user_id is null;
    update partners set role = case when id = owner_id then 'owner' else 'partner' end,
                        status = case when user_id is not null then 'active' else 'invited' end
      where business_id = biz;
    update owner_shares  set business_id = biz where business_id is null;
    update products      set business_id = biz where business_id is null;
    update stock_moves   set business_id = biz where business_id is null;
    update sales         set business_id = biz where business_id is null;
    update sale_items    set business_id = biz where business_id is null;
    update sale_payments set business_id = biz where business_id is null;
    update settlements   set business_id = biz where business_id is null;
    update orders        set business_id = biz where business_id is null;
    update notifications set business_id = biz where business_id is null;
    update messages      set business_id = biz where business_id is null;
    update push_subscriptions s set user_id = p.user_id from partners p where p.id = s.partner_id and s.user_id is null;
  end if;
end $$;

alter table partners      alter column business_id set not null;
alter table owner_shares  alter column business_id set not null;
alter table products      alter column business_id set not null;
alter table stock_moves   alter column business_id set not null;
alter table sales         alter column business_id set not null;
alter table sale_items    alter column business_id set not null;
alter table sale_payments alter column business_id set not null;
alter table settlements   alter column business_id set not null;
alter table orders        alter column business_id set not null;
alter table notifications alter column business_id set not null;
alter table messages      alter column business_id set not null;

create unique index if not exists partners_biz_user_uidx  on partners (business_id, user_id) where user_id is not null and status <> 'removed';
create unique index if not exists partners_biz_email_uidx on partners (lower(email), business_id) where email is not null and status <> 'removed';
create index if not exists partners_user_idx       on partners (user_id);
create index if not exists partners_biz_idx        on partners (business_id);
create index if not exists owner_shares_biz_idx    on owner_shares (business_id);
create index if not exists products_biz_idx        on products (business_id);
create index if not exists stock_moves_biz_idx     on stock_moves (business_id, product_id);
create index if not exists sales_biz_at_idx        on sales (business_id, at desc);
create index if not exists sale_items_sale_idx     on sale_items (sale_id);
create index if not exists sale_payments_sale_idx  on sale_payments (sale_id);
create index if not exists orders_biz_at_idx       on orders (business_id, at desc);
create index if not exists notifications_partner_idx on notifications (partner_id, id desc);
create index if not exists notifications_biz_idx   on notifications (business_id);
create index if not exists messages_biz_idx        on messages (business_id, id desc);
create index if not exists push_user_idx           on push_subscriptions (user_id);

-- ---------------------------------------------------------------- remove the old single-business logic
-- (Old rules and helpers are dropped; they are all replaced below. "cascade" also drops the old policies.)
drop function if exists my_partner() cascade;
drop function if exists sees_whole_sale(bigint) cascade;
drop function if exists sale_has_my_items(bigint) cascade;
drop function if exists record_sale(jsonb, text, text, text);
drop function if exists record_sale(jsonb, text, text, text, numeric, date, bigint);
drop function if exists record_sale(jsonb, text, text, text, numeric, date, bigint, numeric, text);
drop function if exists stock_levels();
drop function if exists my_money(timestamptz);
drop function if exists my_debts();
drop function if exists sales_timeline(int);
drop function if exists create_order(text, jsonb, text);
drop function if exists create_order(text, jsonb, text, timestamptz);
drop function if exists create_order(text, jsonb, text, timestamptz, boolean, numeric);
drop function if exists send_message(text);
drop function if exists mark_notifications_read(bigint);
drop function if exists notify_all(text, text, text, text, text);

-- ---------------------------------------------------------------- who is who
-- Used by every rule below. They only ever answer about the signed-in person.
create or replace function my_member(p_biz uuid) returns text
language sql stable security definer set search_path = busynes as $$
  select id from partners where business_id = p_biz and user_id = auth.uid() and status = 'active' limit 1
$$;
create or replace function my_role(p_biz uuid) returns text
language sql stable security definer set search_path = busynes as $$
  select role from partners where business_id = p_biz and user_id = auth.uid() and status = 'active' limit 1
$$;
-- The ids of the signed-in person in every business they belong to.
create or replace function my_members() returns setof text
language sql stable security definer set search_path = busynes as $$
  select id from partners where user_id = auth.uid() and status = 'active'
$$;
create or replace function has_role(p_biz uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = busynes as $$
  select exists (select 1 from partners where business_id = p_biz and user_id = auth.uid()
                 and status = 'active' and role = any(p_roles))
$$;

-- True when the signed-in person may see the money details of a sale: they recorded it, were paid for it,
-- or the business is in "shared" mode and they are an owner or partner.
create or replace function sees_whole_sale(p_sale bigint) returns boolean
language sql stable security definer set search_path = busynes as $$
  select exists (
    select 1 from sales s join businesses b on b.id = s.business_id
    where s.id = p_sale
      and (s.paid_to = my_member(s.business_id) or s.recorded_by = my_member(s.business_id)
           or (b.privacy = 'shared' and my_role(s.business_id) in ('owner','partner')))
  )
$$;

-- True when the sale contains at least one product the signed-in person owns a share of.
create or replace function sale_has_my_items(p_sale bigint) returns boolean
language sql stable security definer set search_path = busynes as $$
  select exists (select 1 from sales s
                 join sale_items si on si.sale_id = s.id
                 join owner_shares os on os.owner = si.owner and os.business_id = s.business_id
                 where s.id = p_sale and os.partner_id = my_member(s.business_id))
$$;

-- ---------------------------------------------------------------- row level security
alter table businesses         enable row level security;
alter table partners           enable row level security;
alter table owner_shares       enable row level security;
alter table products           enable row level security;
alter table stock_moves        enable row level security;
alter table sales              enable row level security;
alter table sale_items         enable row level security;
alter table sale_payments      enable row level security;
alter table settlements        enable row level security;
alter table orders             enable row level security;
alter table order_fees         enable row level security;
alter table notifications      enable row level security;
alter table messages           enable row level security;
alter table push_subscriptions enable row level security;   -- no policies: only the functions touch it

-- Start from nothing: the app may only READ, and only the columns below. Every change goes through a function.
revoke all on all tables in schema busynes from authenticated, anon;
grant select on businesses, owner_shares, products, stock_moves, sale_items, sale_payments, settlements,
  orders, order_fees, notifications, messages to authenticated;
-- Other people's email addresses and logins are never readable; the owner gets emails through list_members().
grant select (id, business_id, name, phone, role, status) on partners to authenticated;
-- Partners read sales through sales_timeline(). Directly they may only see the plain columns,
-- never the due date, loan fee or fee owner (which would show who owes whom what).
grant select (id, business_id, at, paid_to, method, note, recorded_by) on sales to authenticated;
grant usage on all sequences in schema busynes to authenticated;

-- Policy names are dropped first so this file can be run again.
drop policy if exists biz_read       on businesses;
drop policy if exists partners_read  on partners;
drop policy if exists shares_read    on owner_shares;
drop policy if exists products_read  on products;
drop policy if exists moves_read     on stock_moves;
drop policy if exists sales_read     on sales;
drop policy if exists items_read     on sale_items;
drop policy if exists payments_read  on sale_payments;
drop policy if exists settle_read    on settlements;
drop policy if exists orders_read    on orders;
drop policy if exists fees_read      on order_fees;
drop policy if exists notif_read     on notifications;
drop policy if exists messages_read  on messages;

create policy biz_read on businesses for select to authenticated using (my_member(id) is not null);
create policy partners_read on partners for select to authenticated using (my_member(business_id) is not null);
create policy shares_read on owner_shares for select to authenticated using (has_role(business_id, array['owner','partner']));
create policy products_read on products for select to authenticated using (has_role(business_id, array['owner','partner','staff']));
create policy moves_read on stock_moves for select to authenticated using (has_role(business_id, array['owner','partner','staff']));
create policy sales_read on sales for select to authenticated
  using (has_role(business_id, array['owner','partner','staff']) and (sees_whole_sale(id) or sale_has_my_items(id)));
create policy items_read on sale_items for select to authenticated
  using (has_role(business_id, array['owner','partner','staff'])
         and (sees_whole_sale(sale_id)
              or exists (select 1 from owner_shares os where os.business_id = sale_items.business_id
                         and os.owner = sale_items.owner and os.partner_id = my_member(sale_items.business_id))));
create policy payments_read on sale_payments for select to authenticated
  using (has_role(business_id, array['owner','partner','staff']) and sees_whole_sale(sale_id));
create policy settle_read on settlements for select to authenticated using (has_role(business_id, array['owner','partner','staff']));
create policy orders_read on orders for select to authenticated using (my_member(business_id) is not null);
create policy fees_read on order_fees for select to authenticated
  using (fee_to in (select my_members()));
create policy notif_read on notifications for select to authenticated
  using (partner_id in (select my_members()));
create policy messages_read on messages for select to authenticated using (my_member(business_id) is not null);

-- ---------------------------------------------------------------- internal helpers (not callable from the app)
create or replace function new_id(p_prefix text default 'm') returns text
language sql volatile as $$ select p_prefix || replace(gen_random_uuid()::text, '-', '') $$;

-- Tell one person (only if they have joined).
create or replace function notify(p_partner text, p_kind text, p_title text, p_body text default '', p_ref text default null)
returns void language sql security definer set search_path = busynes as $$
  insert into notifications (business_id, partner_id, kind, title, body, ref)
  select p.business_id, p.id, p_kind, left(p_title, 140), left(coalesce(p_body, ''), 300), p_ref
  from partners p where p.id = p_partner and p.status = 'active'
$$;
-- Tell everyone in a business (optionally not one person, and optionally only some roles).
create or replace function notify_all(p_biz uuid, p_kind text, p_title text, p_body text default '', p_ref text default null,
                                      p_except text default null, p_roles text[] default null)
returns void language sql security definer set search_path = busynes as $$
  insert into notifications (business_id, partner_id, kind, title, body, ref)
  select p_biz, id, p_kind, left(p_title, 140), left(coalesce(p_body, ''), 300), p_ref
  from partners
  where business_id = p_biz and status = 'active'
    and (p_except is null or id <> p_except)
    and (p_roles is null or role = any(p_roles))
$$;
create or replace function sale_outstanding(p_sale bigint) returns numeric
language sql stable security definer set search_path = busynes as $$
  select coalesce((select sum(price * qty) from sale_items where sale_id = p_sale), 0)
       + coalesce((select loan_fee from sales where id = p_sale), 0)
       - coalesce((select sum(amount) from sale_payments where sale_id = p_sale), 0)
$$;

-- ---------------------------------------------------------------- businesses and people
-- Accept any invitations waiting for the signed-in person's (confirmed) email address.
create or replace function claim_memberships() returns int
language plpgsql security definer set search_path = busynes as $$
declare uid uuid := auth.uid(); em text; r record; n int := 0;
begin
  if uid is null then return 0; end if;
  select lower(u.email) into em from auth.users u where u.id = uid and u.email_confirmed_at is not null;
  if em is null then return 0; end if;
  for r in select id, business_id, name from partners
           where user_id is null and status = 'invited' and lower(email) = em loop
    update partners set user_id = uid, status = 'active' where id = r.id;
    perform notify_all(r.business_id, 'member', r.name || ' joined', 'They accepted the invitation.', r.id, r.id, array['owner']);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The businesses the signed-in person belongs to.
drop function if exists my_businesses();
create or replace function my_businesses()
returns table (id uuid, name text, kind text, role text, member_id text, privacy text, owner_name text, team_settle boolean)
language sql stable security definer set search_path = busynes as $$
  select b.id, b.name, b.kind, p.role, p.id, b.privacy,
         (select o.name from partners o where o.business_id = b.id and o.role = 'owner' and o.status <> 'removed' limit 1),
         b.team_settle
  from partners p join businesses b on b.id = p.business_id
  where p.user_id = auth.uid() and p.status = 'active'
  order by b.created_at, b.id
$$;

create or replace function create_business(p_name text, p_kind text default '', p_my_name text default '') returns uuid
language plpgsql security definer set search_path = busynes as $$
declare
  uid uuid := auth.uid();
  em text := lower(coalesce(auth.jwt() ->> 'email', ''));
  nm text := btrim(coalesce(p_name, ''));
  myn text := btrim(coalesce(p_my_name, ''));
  biz uuid; mid text := new_id('m');
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if length(nm) not between 1 and 60 then raise exception 'Give the business a name (up to 60 letters)'; end if;
  if (select count(*) from partners where user_id = uid and role = 'owner' and status = 'active') >= 5 then
    raise exception 'You can run up to 5 businesses';
  end if;
  if myn = '' then myn := initcap(split_part(em, '@', 1)); end if;
  insert into businesses (name, kind, created_by) values (nm, left(btrim(coalesce(p_kind, '')), 40), uid) returning id into biz;
  insert into partners (id, business_id, user_id, email, name, role, status)
    values (mid, biz, uid, nullif(em, ''), left(myn, 40), 'owner', 'active');
  -- Everything starts out owned by the owner; give partners a share on the settings page or when inviting them.
  insert into owner_shares (business_id, owner, partner_id, share) values (biz, 'everyone', mid, 1);
  return biz;
end $$;

drop function if exists update_business(uuid, text, text, text);
create or replace function update_business(p_biz uuid, p_name text default null, p_kind text default null, p_privacy text default null,
                                            p_team_settle boolean default null)
returns void language plpgsql security definer set search_path = busynes as $$
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can change this'; end if;
  if p_name is not null and length(btrim(p_name)) not between 1 and 60 then raise exception 'Give the business a name (up to 60 letters)'; end if;
  if p_privacy is not null and p_privacy not in ('shared','private') then raise exception 'Unknown privacy setting'; end if;
  update businesses set name = coalesce(btrim(p_name), name), kind = coalesce(left(btrim(p_kind), 40), kind),
                        privacy = coalesce(p_privacy, privacy), team_settle = coalesce(p_team_settle, team_settle)
  where id = p_biz;
end $$;

-- Delete a business and everything in it. The owner must type its name to confirm.
create or replace function delete_business(p_biz uuid, p_confirm text) returns void
language plpgsql security definer set search_path = busynes as $$
declare nm text;
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can delete the business'; end if;
  select name into nm from businesses where id = p_biz;
  if lower(btrim(coalesce(p_confirm, ''))) <> lower(btrim(nm)) then raise exception 'Type the business name exactly to confirm'; end if;
  delete from notifications where business_id = p_biz;
  delete from messages where business_id = p_biz;
  delete from order_fees where order_id in (select id from orders where business_id = p_biz);
  delete from orders where business_id = p_biz;
  delete from sale_payments where business_id = p_biz;
  delete from sale_items where business_id = p_biz;
  delete from sales where business_id = p_biz;
  delete from stock_moves where business_id = p_biz;
  delete from settlements where business_id = p_biz;
  delete from products where business_id = p_biz;
  delete from owner_shares where business_id = p_biz;
  delete from push_subscriptions where partner_id in (select id from partners where business_id = p_biz);
  delete from partners where business_id = p_biz;
  delete from businesses where id = p_biz;
end $$;

-- Everyone in the business, with email addresses shown only to the owner.
create or replace function list_members(p_biz uuid)
returns table (id text, name text, email text, phone text, role text, status text)
language sql stable security definer set search_path = busynes as $$
  select p.id, p.name, case when my_role(p_biz) = 'owner' then p.email end, p.phone, p.role, p.status
  from partners p
  where p.business_id = p_biz and p.status <> 'removed' and my_member(p_biz) is not null
  order by case p.role when 'owner' then 0 when 'partner' then 1 when 'staff' then 2 else 3 end, p.name
$$;

-- Who owns which group of products. Percentages are only shown to owners and partners.
create or replace function my_groups(p_biz uuid) returns table (owner text, partner_id text, share numeric)
language sql stable security definer set search_path = busynes as $$
  select os.owner, os.partner_id, case when my_role(p_biz) in ('owner','partner') then os.share end
  from owner_shares os
  where os.business_id = p_biz and my_member(p_biz) is not null
  order by os.owner, os.partner_id
$$;

-- Invite someone by email. If they already have a confirmed login they are added straight away;
-- otherwise they join the moment they sign up or sign in with this email.
-- p_share is a fraction (0.35 = 35%) taken from the owner's part of p_group; only for partners.
create or replace function invite_member(p_biz uuid, p_email text, p_name text, p_role text,
                                         p_group text default null, p_share numeric default 0) returns text
language plpgsql security definer set search_path = busynes as $$
declare
  em text := lower(btrim(coalesce(p_email, '')));
  nm text := btrim(coalesce(p_name, ''));
  mid text := new_id('m');
  owner_m text := my_member(p_biz);
  uid uuid; cur numeric; biz_name text;
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can invite people'; end if;
  if p_role not in ('partner','staff','delivery') then raise exception 'Choose partner, staff or delivery'; end if;
  if em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'That email address does not look right'; end if;
  if (select count(*) from partners where business_id = p_biz and status <> 'removed') >= 25 then
    raise exception 'A business can have up to 25 people';
  end if;
  if exists (select 1 from partners where business_id = p_biz and status <> 'removed' and lower(email) = em) then
    raise exception 'That person is already in this business';
  end if;
  if nm = '' then nm := initcap(split_part(em, '@', 1)); end if;
  if coalesce(p_share, 0) < 0 or coalesce(p_share, 0) >= 1 then raise exception 'The share must be between 0%% and 100%%'; end if;
  if coalesce(p_share, 0) > 0 and p_role <> 'partner' then raise exception 'Only partners can own a share'; end if;

  insert into partners (id, business_id, email, name, role, status) values (mid, p_biz, em, left(nm, 40), p_role, 'invited');

  if coalesce(p_share, 0) > 0 then
    select share into cur from owner_shares where business_id = p_biz and owner = p_group and partner_id = owner_m;
    if cur is null or cur - p_share < 0.0001 then
      raise exception 'You don''t own enough of that group to give away that share';
    end if;
    update owner_shares set share = share - p_share where business_id = p_biz and owner = p_group and partner_id = owner_m;
    insert into owner_shares (business_id, owner, partner_id, share) values (p_biz, p_group, mid, p_share);
  end if;

  select u.id into uid from auth.users u where lower(u.email) = em and u.email_confirmed_at is not null limit 1;
  if uid is not null then
    update partners set user_id = uid, status = 'active' where id = mid;
    select name into biz_name from businesses where id = p_biz;
    perform notify(mid, 'member', 'You were added to ' || biz_name, 'Open the business from the menu at the top.', null);
  end if;
  return mid;
end $$;

create or replace function update_member(p_biz uuid, p_member text, p_role text default null, p_name text default null)
returns void language plpgsql security definer set search_path = busynes as $$
declare m partners%rowtype;
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can change people'; end if;
  select * into m from partners where id = p_member and business_id = p_biz and status <> 'removed';
  if not found then raise exception 'That person is not in this business'; end if;
  if m.role = 'owner' and p_role is not null and p_role <> 'owner' then raise exception 'The owner''s role can''t be changed'; end if;
  if p_role is not null then
    if p_role not in ('partner','staff','delivery') and m.role <> 'owner' then raise exception 'Choose partner, staff or delivery'; end if;
    if p_role in ('staff','delivery') and exists (select 1 from owner_shares where business_id = p_biz and partner_id = p_member) then
      raise exception 'Take them out of the ownership groups first (Ownership section)';
    end if;
  end if;
  update partners set role = coalesce(p_role, role), name = coalesce(nullif(left(btrim(p_name), 40), ''), name) where id = p_member;
end $$;

create or replace function remove_member(p_biz uuid, p_member text) returns void
language plpgsql security definer set search_path = busynes as $$
declare m partners%rowtype;
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can remove people'; end if;
  select * into m from partners where id = p_member and business_id = p_biz and status <> 'removed';
  if not found then raise exception 'That person is not in this business'; end if;
  if m.role = 'owner' then raise exception 'The owner can''t be removed'; end if;
  if exists (select 1 from owner_shares where business_id = p_biz and partner_id = p_member) then
    raise exception 'Take them out of the ownership groups first (Ownership section)';
  end if;
  update partners set status = 'removed' where id = p_member;
end $$;

create or replace function leave_business(p_biz uuid) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_member(p_biz);
begin
  if me is null then raise exception 'You are not part of this business'; end if;
  if my_role(p_biz) = 'owner' then raise exception 'The owner can''t leave. Delete the business instead.'; end if;
  if exists (select 1 from owner_shares where business_id = p_biz and partner_id = me) then
    raise exception 'Ask the owner to take you out of the ownership groups first';
  end if;
  update partners set status = 'removed' where id = me;
end $$;

-- Set who owns a group of products and how much each person has. Shares are fractions that must add up to 1.
-- Changes apply to everything not settled yet, so settle up first if you want older sales left as they were.
create or replace function set_group_shares(p_biz uuid, p_group text, p_shares jsonb) returns void
language plpgsql security definer set search_path = busynes as $$
declare g text := btrim(coalesce(p_group, '')); e jsonb; total numeric := 0; sh numeric;
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can change who owns what'; end if;
  if length(g) not between 1 and 40 then raise exception 'Give the group a short name'; end if;
  if jsonb_typeof(p_shares) <> 'array' or jsonb_array_length(p_shares) = 0 then raise exception 'Choose who owns this group'; end if;
  for e in select * from jsonb_array_elements(p_shares) loop
    sh := (e ->> 'share')::numeric;
    if sh is null or sh <= 0 or sh > 1 then raise exception 'Each share must be above 0%% and up to 100%%'; end if;
    if not exists (select 1 from partners where id = e ->> 'partner_id' and business_id = p_biz
                   and status <> 'removed' and role in ('owner','partner')) then
      raise exception 'Only the owner and partners can own a share';
    end if;
    total := total + sh;
  end loop;
  if abs(total - 1) > 0.0005 then raise exception 'The shares must add up to 100%% (they add up to % percent)', round(total * 100, 2); end if;
  delete from owner_shares where business_id = p_biz and owner = g;
  insert into owner_shares (business_id, owner, partner_id, share)
    select p_biz, g, e2 ->> 'partner_id', round((e2 ->> 'share')::numeric, 4) from jsonb_array_elements(p_shares) e2;
end $$;

create or replace function delete_group(p_biz uuid, p_group text) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  if not has_role(p_biz, array['owner']) then raise exception 'Only the owner can change who owns what'; end if;
  if exists (select 1 from products where business_id = p_biz and owner = p_group) then
    raise exception 'Move or hide the products in this group first';
  end if;
  if (select count(distinct owner) from owner_shares where business_id = p_biz) <= 1 then
    raise exception 'A business needs at least one ownership group';
  end if;
  delete from owner_shares where business_id = p_biz and owner = p_group;
end $$;

-- ---------------------------------------------------------------- products, stock and settling up
create or replace function add_product(p_biz uuid, p_name text, p_price numeric, p_group text, p_track boolean default true)
returns text language plpgsql security definer set search_path = busynes as $$
declare pid text := new_id('p'); nm text := btrim(coalesce(p_name, ''));
begin
  if not has_role(p_biz, array['owner','partner']) then raise exception 'Only the owner and partners can add products'; end if;
  if length(nm) not between 1 and 40 then raise exception 'Give the product a name (up to 40 letters)'; end if;
  if p_price is null or p_price < 0 or p_price > 1000000 then raise exception 'Enter a price'; end if;
  if not exists (select 1 from owner_shares where business_id = p_biz and owner = p_group) then raise exception 'Choose whose stock it is'; end if;
  insert into products (id, business_id, name, price, owner, sort, track_stock)
    values (pid, p_biz, nm, p_price, p_group, 99, coalesce(p_track, true));
  return pid;
end $$;

create or replace function update_product(p_id text, p_name text default null, p_price numeric default null,
                                          p_hidden boolean default null, p_track boolean default null)
returns void language plpgsql security definer set search_path = busynes as $$
declare biz uuid;
begin
  select business_id into biz from products where id = p_id;
  if biz is null or not has_role(biz, array['owner','partner']) then raise exception 'Only the owner and partners can change products'; end if;
  if p_name is not null and length(btrim(p_name)) not between 1 and 40 then raise exception 'Give the product a name (up to 40 letters)'; end if;
  if p_price is not null and (p_price < 0 or p_price > 1000000) then raise exception 'Enter a price'; end if;
  update products set name = coalesce(btrim(p_name), name), price = coalesce(p_price, price),
                      hidden = coalesce(p_hidden, hidden), track_stock = coalesce(p_track, track_stock)
  where id = p_id;
end $$;

create or replace function add_stock_move(p_biz uuid, p_product text, p_kind text, p_qty int) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  if not has_role(p_biz, array['owner','partner','staff']) then raise exception 'You can''t change stock in this business'; end if;
  if p_kind not in ('add','count') then raise exception 'Unknown stock change'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 1000000 or (p_kind = 'add' and p_qty < 1) then raise exception 'Enter a quantity'; end if;
  if not exists (select 1 from products where id = p_product and business_id = p_biz) then raise exception 'Unknown product'; end if;
  insert into stock_moves (business_id, product_id, kind, qty, by) values (p_biz, p_product, p_kind, p_qty, my_member(p_biz));
end $$;

-- Stock on hand for every tracked product: last count + later deliveries - later sales.
create or replace function stock_levels(p_biz uuid) returns table (product_id text, qty int)
language sql stable security definer set search_path = busynes as $$
  with last_count as (
    select distinct on (m.product_id) m.product_id, m.qty, m.at
    from stock_moves m where m.kind = 'count' and m.business_id = p_biz
    order by m.product_id, m.at desc, m.id desc
  )
  select pr.id,
    case when pr.track_stock then
      (coalesce(lc.qty, 0)
       + coalesce((select sum(m.qty) from stock_moves m
                   where m.product_id = pr.id and m.kind = 'add'
                     and (lc.at is null or m.at > lc.at)), 0)
       - coalesce((select sum(si.qty) from sale_items si join sales s on s.id = si.sale_id
                   where si.product_id = pr.id and (lc.at is null or s.at > lc.at)), 0))::int
    end
  from products pr
  left join last_count lc on lc.product_id = pr.id
  where pr.business_id = p_biz and has_role(p_biz, array['owner','partner','staff'])
$$;

create or replace function mark_settled(p_biz uuid) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_member(p_biz); my_name text;
begin
  if not has_role(p_biz, array['owner','partner']) then raise exception 'Only the owner and partners can mark things as settled'; end if;
  insert into settlements (business_id, by) values (p_biz, me);
  select name into my_name from partners where id = me;
  perform notify_all(p_biz, 'settle', my_name || ' marked everything as settled', 'Balances start again from zero.', null, me, array['owner','partner','staff']);
end $$;

-- ---------------------------------------------------------------- sales
-- Record a sale. Prices come from the products table, not from the phone.
-- p_items: [{"product_id": "p123", "qty": 2}, ...]
-- p_paid:  how much was paid now (null = paid in full). Less than the total = on credit.
-- p_due:   the date the rest was promised. p_order: an open order this sale fulfils.
-- p_fee:   a loan fee charged on top of the items. It is added to what the customer owes and belongs
--          to p_fee_to (default: whoever records the sale), not to the owners of the items.
create or replace function record_sale(p_biz uuid, p_items jsonb, p_paid_to text, p_method text, p_note text default '',
                                       p_paid numeric default null, p_due date default null, p_order bigint default null,
                                       p_fee numeric default 0, p_fee_to text default null)
returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_member(p_biz);
  my_name text;
  paid_name text;
  new_id bigint;
  it jsonb;
  p products%rowtype;
  items_total numeric := 0;
  total numeric;
  fee numeric := coalesce(p_fee, 0);
  fee_who text := coalesce(p_fee_to, my_member(p_biz));
  paid numeric;
  lines text := '';
  mine text;
  r record;
  qty_left int;
  cust text := left(coalesce(p_note, ''), 120);
begin
  if not has_role(p_biz, array['owner','partner','staff']) then raise exception 'You can''t record sales in this business'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  if p_method not in ('cash','transfer') then raise exception 'Payment must be cash or transfer'; end if;
  if not exists (select 1 from partners where id = p_paid_to and business_id = p_biz and status <> 'removed') then
    raise exception 'Choose who got the money';
  end if;
  if fee < 0 or fee > 100000 then raise exception 'That loan fee does not look right'; end if;
  if fee > 0 and not exists (select 1 from partners where id = fee_who and business_id = p_biz and status <> 'removed') then
    raise exception 'Unknown person for the loan fee';
  end if;
  select name into my_name from partners where id = me;
  insert into sales (business_id, paid_to, method, note, recorded_by, loan_fee, fee_to)
    values (p_biz, p_paid_to, p_method, cust, me, fee, case when fee > 0 then fee_who end)
    returning id into new_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id' and business_id = p_biz;
    if not found then raise exception 'Unknown product'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    insert into sale_items (business_id, sale_id, product_id, name, owner, price, qty)
      values (p_biz, new_id, p.id, p.name, p.owner, p.price, (it ->> 'qty')::int);
    items_total := items_total + p.price * (it ->> 'qty')::int;
    lines := lines || case when lines = '' then '' else ', ' end || (it ->> 'qty') || ' × ' || p.name;
  end loop;
  total := items_total + fee;

  paid := coalesce(p_paid, total);
  if paid < 0 or paid > total then raise exception 'The amount paid must be between R0 and the total'; end if;
  if paid < total then
    if cust = '' then raise exception 'Put the customer''s name on a sale that is not paid in full'; end if;
    update sales set due_on = p_due where id = new_id;
  end if;
  if paid > 0 then
    insert into sale_payments (business_id, sale_id, amount, method, paid_to, recorded_by)
      values (p_biz, new_id, paid, p_method, p_paid_to, me);
  end if;
  if p_order is not null then
    update orders set status = 'done', sale_id = new_id where id = p_order and business_id = p_biz and status = 'open';
  end if;

  -- Tell everyone else, so whoever is free can deal with it. Amounts, fees and who owes stay private:
  -- only the person holding the money gets figures.
  select name into paid_name from partners where id = p_paid_to;
  for r in select id, role from partners where business_id = p_biz and status = 'active' and id <> me loop
    mine := (select string_agg(si.qty || ' × ' || si.name, ', ')
             from sale_items si
             where si.sale_id = new_id
               and exists (select 1 from owner_shares os where os.owner = si.owner and os.business_id = p_biz and os.partner_id = r.id));
    if r.id = p_paid_to then
      perform notify(r.id, case when paid < total then 'credit' else 'sale' end,
        my_name || case when paid < total then ' put a sale on credit with you' else ' recorded a sale paid to you' end,
        lines || ' · R' || total || case when paid < total then ' · owes R' || (total - paid) ||
          case when p_due is not null then ' by ' || to_char(p_due, 'DD Mon') else '' end || ' (' || cust || ')'
          else '' end,
        new_id::text);
    elsif r.role = 'delivery' then
      null;   -- delivery people don't see sales
    elsif mine is not null then
      perform notify(r.id, 'sale', 'Your stock sold: ' || mine,
        'Sold by ' || my_name || case when paid > 0 then ' · money with ' || paid_name else '' end, new_id::text);
    else
      perform notify(r.id, 'sale', my_name || ' sold ' || lines,
        case when paid > 0 then 'Money with ' || paid_name else '' end, new_id::text);
    end if;
  end loop;

  -- Running low? Tell everyone once, when a sale pushes a tracked product down to 3 or fewer.
  for r in select si.product_id, max(si.name) as name, sum(si.qty)::int as sold
           from sale_items si where si.sale_id = new_id group by si.product_id loop
    select sl.qty into qty_left from stock_levels(p_biz) sl where sl.product_id = r.product_id;
    if qty_left is not null and qty_left <= 3 and qty_left + r.sold > 3 then
      perform notify_all(p_biz, 'stock', 'Running low: ' || r.name, qty_left || ' left', r.product_id, null, array['owner','partner','staff']);
    end if;
  end loop;
  return new_id;
end $$;

-- Record money coming in on a sale that was not paid in full.
create or replace function record_payment(p_sale bigint, p_amount numeric, p_method text default 'cash', p_paid_to text default null)
returns void
language plpgsql security definer set search_path = busynes as $$
declare
  s sales%rowtype;
  me text;
  my_name text;
  left_over numeric;
  r record;
begin
  select * into s from sales where id = p_sale;
  if not found or not has_role(s.business_id, array['owner','partner','staff']) or not sees_whole_sale(p_sale) then
    raise exception 'You can only take payments on sales you recorded or collect';
  end if;
  me := my_member(s.business_id);
  if p_method not in ('cash','transfer') then raise exception 'Payment must be cash or transfer'; end if;
  if p_paid_to is not null and not exists (select 1 from partners where id = p_paid_to and business_id = s.business_id and status <> 'removed') then
    raise exception 'Choose who received the money';
  end if;
  left_over := sale_outstanding(p_sale);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above R0'; end if;
  if p_amount > left_over + 0.005 then raise exception 'That is more than what is still owed (R%)', round(left_over, 2); end if;
  insert into sale_payments (business_id, sale_id, amount, method, paid_to, recorded_by)
    values (s.business_id, p_sale, p_amount, p_method, coalesce(p_paid_to, me), me);
  select name into my_name from partners where id = me;
  for r in select id from partners where business_id = s.business_id and status = 'active' and id <> me and role <> 'delivery' loop
    if r.id in (s.paid_to, s.recorded_by) or exists (
         select 1 from sale_items si join owner_shares os on os.owner = si.owner and os.business_id = s.business_id
         where si.sale_id = p_sale and os.partner_id = r.id) then
      perform notify(r.id, 'payment',
        case when r.id in (s.paid_to, s.recorded_by) then coalesce(nullif(s.note, ''), 'A customer') || ' paid R' || round(p_amount, 2)
             else 'A customer paid on your stock' end,
        case when r.id in (s.paid_to, s.recorded_by)
             then case when left_over - p_amount <= 0.005 then 'Fully paid now' else 'R' || round(left_over - p_amount, 2) || ' still owed' end
             else 'Recorded by ' || my_name end,
        p_sale::text);
    end if;
  end loop;
end $$;

-- Move the promised date of an unpaid balance.
create or replace function set_sale_due(p_sale bigint, p_due date) returns void
language plpgsql security definer set search_path = busynes as $$
declare biz uuid;
begin
  select business_id into biz from sales where id = p_sale;
  if biz is null or not has_role(biz, array['owner','partner','staff']) or not sees_whole_sale(p_sale) then raise exception 'Not your sale'; end if;
  update sales set due_on = p_due where id = p_sale;
end $$;

-- Delete a sale (to fix a mistake): whoever recorded it, whoever was paid, or the owner.
create or replace function delete_sale(p_id bigint) returns void
language plpgsql security definer set search_path = busynes as $$
declare s sales%rowtype; me text;
begin
  select * into s from sales where id = p_id;
  if not found then raise exception 'You can only delete sales you recorded or were paid for'; end if;
  me := my_member(s.business_id);
  if me is null or not (s.recorded_by = me or s.paid_to = me or has_role(s.business_id, array['owner'])) then
    raise exception 'You can only delete sales you recorded or were paid for';
  end if;
  delete from sales where id = p_id;
end $$;

-- Sales that still have money owing, for the people who may see that sale's money.
-- total includes any loan fee; loan_fee is shown separately.
create or replace function my_debts(p_biz uuid)
returns table (sale_id bigint, at timestamptz, customer text, items text, total numeric, paid numeric,
               outstanding numeric, due_on date, paid_to text, recorded_by text, loan_fee numeric)
language sql stable security definer set search_path = busynes as $$
  select s.id, s.at, s.note,
         (select string_agg(i.qty || ' × ' || i.name, ', ' order by i.id) from sale_items i where i.sale_id = s.id),
         t.total + s.loan_fee, coalesce(p.paid, 0), t.total + s.loan_fee - coalesce(p.paid, 0), s.due_on, s.paid_to, s.recorded_by, s.loan_fee
  from sales s
  join lateral (select sum(price * qty) as total from sale_items where sale_id = s.id) t on true
  left join lateral (select sum(amount) as paid from sale_payments where sale_id = s.id) p on true
  where s.business_id = p_biz
    and has_role(p_biz, array['owner','partner','staff'])
    and sees_whole_sale(s.id)
    and t.total + s.loan_fee - coalesce(p.paid, 0) > 0.005
  order by s.due_on nulls last, s.at
$$;

-- The team's sales trail, newest first. Everyone who can sell sees WHAT was sold, WHEN, by WHOM, where the money
-- went and the note. Prices, totals, loan fees, what is still owed and due dates are only filled in
-- for sales the caller may see the money of (and prices for the caller's own products).
create or replace function sales_timeline(p_biz uuid, p_limit int default 300)
returns table (id bigint, at timestamptz, paid_to text, recorded_by text, method text, note text,
               due_on date, whole boolean, total numeric, paid numeric, loan_fee numeric, items jsonb)
language sql stable security definer set search_path = busynes as $$
  select s.id, s.at, s.paid_to, s.recorded_by, s.method, s.note,
         case when w.whole then s.due_on end,
         w.whole,
         case when w.whole then t.total + s.loan_fee end,
         case when w.whole then coalesce(p.paid, 0) end,
         case when w.whole then s.loan_fee end,
         (select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'owner', i.owner,
                  'price', case when w.whole or exists (select 1 from owner_shares os
                                                        where os.owner = i.owner and os.business_id = p_biz
                                                          and os.partner_id = my_member(p_biz))
                                then i.price end) order by i.id)
          from sale_items i where i.sale_id = s.id)
  from sales s
  cross join lateral (select sees_whole_sale(s.id) as whole) w
  join lateral (select sum(price * qty) as total from sale_items where sale_id = s.id) t on true
  left join lateral (select sum(amount) as paid from sale_payments where sale_id = s.id) p on true
  where s.business_id = p_biz and has_role(p_biz, array['owner','partner','staff'])
  order by s.at desc, s.id desc
  limit least(greatest(coalesce(p_limit, 300), 1), 500)
$$;

-- ---------------------------------------------------------------- orders
-- p_at:   when the order came in (null = now), so an order you forgot to write down can be added later.
-- p_loan: the items are lent out and paid back later. p_fee: the fee you plan to charge; only you can see it.
create or replace function create_order(p_biz uuid, p_customer text, p_items jsonb, p_note text default '', p_at timestamptz default null,
                                        p_loan boolean default false, p_fee numeric default 0) returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_member(p_biz);
  my_name text; new_id bigint; it jsonb; p products%rowtype;
  clean jsonb := '[]'::jsonb; lines text := '';
  loan boolean := coalesce(p_loan, false);
begin
  if not has_role(p_biz, array['owner','partner','staff']) then raise exception 'You can''t add orders in this business'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'An order needs at least one item'; end if;
  if p_at is not null and p_at > now() + interval '5 minutes' then raise exception 'The order date can''t be in the future'; end if;
  if coalesce(p_fee, 0) < 0 or coalesce(p_fee, 0) > 100000 then raise exception 'That loan fee does not look right'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id' and business_id = p_biz;
    if not found then raise exception 'Unknown product'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    clean := clean || jsonb_build_object('product_id', p.id, 'name', p.name, 'qty', (it ->> 'qty')::int);
    lines := lines || case when lines = '' then '' else ', ' end || (it ->> 'qty') || ' × ' || p.name;
  end loop;
  insert into orders (business_id, at, customer, items, note, created_by, loan)
    values (p_biz, coalesce(p_at, now()), left(coalesce(p_customer, ''), 80), clean, left(coalesce(p_note, ''), 200), me, loan)
    returning id into new_id;
  if loan and coalesce(p_fee, 0) > 0 then
    insert into order_fees (order_id, fee, fee_to) values (new_id, p_fee, me);
  end if;
  select name into my_name from partners where id = me;
  perform notify_all(p_biz, 'order', case when loan then 'New loan order' else 'New order' end ||
                     case when coalesce(p_customer, '') <> '' then ' from ' || left(p_customer, 40) else '' end,
                     lines || ' · added by ' || my_name, new_id::text, me);
  return new_id;
end $$;

create or replace function cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = busynes as $$
declare biz uuid;
begin
  select business_id into biz from orders where id = p_id;
  if biz is null or not has_role(biz, array['owner','partner','staff']) then raise exception 'You can''t cancel this order'; end if;
  update orders set status = 'cancelled' where id = p_id and status = 'open';
end $$;

-- "I'll take it" on an open order, so two people don't both chase it. p_take = false lets go again.
create or replace function claim_order(p_id bigint, p_take boolean default true) returns void
language plpgsql security definer set search_path = busynes as $$
declare
  me text; my_name text; o orders%rowtype; what text;
begin
  select * into o from orders where id = p_id for update;
  if not found then raise exception 'That order is no longer open'; end if;
  me := my_member(o.business_id);
  if me is null then raise exception 'That order is no longer open'; end if;
  if o.status <> 'open' then raise exception 'That order is no longer open'; end if;
  select name into my_name from partners where id = me;
  what := coalesce(nullif(o.customer, ''), 'An order') || ' · ' ||
          coalesce((select string_agg((e ->> 'qty') || ' × ' || (e ->> 'name'), ', ') from jsonb_array_elements(o.items) e), '');
  if p_take then
    if o.claimed_by is not null and o.claimed_by <> me then
      raise exception '% is already on this order', (select name from partners where id = o.claimed_by);
    end if;
    update orders set claimed_by = me, claimed_at = now() where id = p_id;
    perform notify_all(o.business_id, 'order', my_name || ' is on it', what, p_id::text, me);
  else
    if o.claimed_by is distinct from me then raise exception 'You are not on this order'; end if;
    update orders set claimed_by = null, claimed_at = null where id = p_id;
    perform notify_all(o.business_id, 'order', my_name || ' can''t take the order after all', what, p_id::text, me);
  end if;
end $$;

-- ---------------------------------------------------------------- chat, alerts, phones
create or replace function send_message(p_biz uuid, p_body text) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_member(p_biz); my_name text; b text := btrim(coalesce(p_body, ''));
begin
  if me is null then raise exception 'You are not part of this business'; end if;
  if b = '' then raise exception 'Type a message first'; end if;
  insert into messages (business_id, from_partner, body) values (p_biz, me, left(b, 500));
  select name into my_name from partners where id = me;
  perform notify_all(p_biz, 'chat', my_name, left(b, 120), null, me);
end $$;

create or replace function mark_notifications_read(p_biz uuid, p_up_to bigint default null) returns void
language sql security definer set search_path = busynes as $$
  update notifications set read_at = now()
  where business_id = p_biz and partner_id = my_member(p_biz) and read_at is null and (p_up_to is null or id <= p_up_to)
$$;

-- "Call me": a pushed alert telling someone in your business to ring you.
create or replace function ping_partner(p_to text, p_text text default 'Please call me') returns void
language plpgsql security definer set search_path = busynes as $$
declare biz uuid; me text; my_name text;
begin
  select business_id into biz from partners where id = p_to and status = 'active';
  me := my_member(biz);
  if biz is null or me is null then raise exception 'You are not part of this business'; end if;
  select name into my_name from partners where id = me;
  perform notify(p_to, 'call', my_name || ' wants you to call', left(coalesce(p_text, ''), 100), me);
end $$;

-- Your number is yours: it is saved on all your memberships.
create or replace function set_my_phone(p_phone text) returns void
language plpgsql security definer set search_path = busynes as $$
declare clean text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if clean <> '' and length(regexp_replace(clean, '[^0-9]', '', 'g')) not between 9 and 15 then
    raise exception 'That does not look like a phone number';
  end if;
  update partners set phone = nullif(clean, '') where user_id = auth.uid() and status = 'active';
end $$;

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
create or replace function remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = busynes as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Run once a day (see reminders.sql): nudge whoever is collecting an unpaid balance.
create or replace function send_due_reminders() returns int
language plpgsql security definer set search_path = busynes as $$
declare
  today date := (now() at time zone 'Africa/Johannesburg')::date;
  r record; who text; n int := 0; phrase text;
begin
  for r in
    select s.id, s.note, s.due_on, s.paid_to, s.recorded_by, sale_outstanding(s.id) as owing
    from sales s
    where s.due_on is not null and sale_outstanding(s.id) > 0.005
      and (s.due_on = today or s.due_on = today + 2 or (s.due_on < today and (today - s.due_on) % 3 = 0))
  loop
    phrase := case when r.due_on = today then 'Due today'
                   when r.due_on > today then 'Due in 2 days (' || to_char(r.due_on, 'DD Mon') || ')'
                   else 'Overdue by ' || (today - r.due_on) || ' days' end;
    for who in select distinct x from unnest(array[r.paid_to, r.recorded_by]) x loop
      if not exists (select 1 from notifications where partner_id = who and kind = 'reminder'
                     and ref = r.id::text and (at at time zone 'Africa/Johannesburg')::date = today) then
        perform notify(who, 'reminder', coalesce(nullif(r.note, ''), 'A customer') || ' owes R' || round(r.owing, 2), phrase, r.id::text);
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- money
-- The signed-in person's own money for a period (p_from = null means all time).
-- Returns only their numbers, plus the settle-up payments they are part of.
-- Money counts when it is actually collected. Each payment is shared out in proportion to what the sale
-- was made of: the owners of the items get their share of the items, and whoever charged a loan fee
-- gets the fee's share. So a credit sale only moves money as the customer pays it back.
create or replace function my_money(p_biz uuid, p_from timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = busynes as $$
declare
  me text := my_member(p_biz);
  ids text[]; nets numeric[];
  i int; j int; amt numeric;
  pays jsonb := '[]'::jsonb;
  mine jsonb;
  sold jsonb;
  owing numeric;
  due_me numeric;
  fees_me numeric;
  pid text[]; pteam text[]; my_team text; team_on boolean;
begin
  if me is null then raise exception 'You are not part of this business'; end if;
  select b.team_settle into team_on from businesses b where b.id = p_biz;

  -- everyone's balance = money received - their share of the money collected
  select array_agg(x.id order by x.id), array_agg(x.net order by x.id) into ids, nets
  from (
    select p.id,
      coalesce((select sum(pay.amount) from sale_payments pay
                where pay.business_id = p_biz and pay.paid_to = p.id and (p_from is null or pay.at > p_from)), 0)
      - coalesce((select sum(pay.amount * (coalesce(mv.v, 0) + case when s.fee_to = p.id then s.loan_fee else 0 end) / (tot.v + s.loan_fee))
                  from sale_payments pay
                  join sales s on s.id = pay.sale_id
                  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
                  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                                     join owner_shares os on os.owner = si.owner and os.partner_id = p.id
                                     where si.sale_id = pay.sale_id) mv on true
                  where pay.business_id = p_biz and (p_from is null or pay.at > p_from)), 0) as net
    from partners p
    where p.business_id = p_biz and p.status <> 'removed'
  ) x;

  -- When the business turns on "settle as teams", people who co-own the same stock (like Vusi and Dokotela with
  -- the beers) settle up as ONE team: their balances are added together, so you pay the team once, to either of them.
  -- Otherwise everybody settles individually, by their own share.
  if team_on then
    with recursive edges as (
      select a.partner_id as a, b.partner_id as b
      from owner_shares a join owner_shares b on a.owner = b.owner and a.business_id = b.business_id
      where a.business_id = p_biz
    ), reach(p, q) as (
      select a, b from edges
      union
      select r.p, e.b from reach r join edges e on e.a = r.q
    )
    select array_agg(pt.id order by pt.id), array_agg(coalesce(tm.team, pt.id) order by pt.id)
    into pid, pteam
    from partners pt left join (select p, min(q) as team from reach group by p) tm on tm.p = pt.id
    where pt.business_id = p_biz and pt.status <> 'removed';
  else
    select array_agg(pt.id order by pt.id), array_agg(pt.id order by pt.id)
    into pid, pteam
    from partners pt where pt.business_id = p_biz and pt.status <> 'removed';
  end if;
  my_team := pteam[array_position(pid, me)];
  select array_agg(g.team order by g.team), array_agg(g.net order by g.team)
  into ids, nets
  from (select u.team, sum(u.net) as net from unnest(pid, nets, pteam) as u(id, net, team) group by u.team) g;

  -- pair whoever holds the most extra with whoever is shortest, until all even
  loop
    i := null; j := null;
    for k in 1 .. coalesce(array_length(ids, 1), 0) loop
      if nets[k] > 0.005 and (i is null or nets[k] > nets[i]) then i := k; end if;
      if nets[k] < -0.005 and (j is null or nets[k] < nets[j]) then j := k; end if;
    end loop;
    exit when i is null or j is null;
    amt := least(nets[i], -nets[j]);
    if ids[i] = my_team or ids[j] = my_team then
      pays := pays || jsonb_build_object('from', ids[i], 'to', ids[j], 'amount', round(amt, 2),
        'from_ids',  (select jsonb_agg(u.id order by u.id) from unnest(pid, pteam) as u(id, team) where u.team = ids[i]),
        'to_ids',    (select jsonb_agg(u.id order by u.id) from unnest(pid, pteam) as u(id, team) where u.team = ids[j]),
        'from_name', (select string_agg(pt.name, ' & ' order by pt.name) from partners pt join unnest(pid, pteam) as u(id, team) on u.id = pt.id where u.team = ids[i]),
        'to_name',   (select string_agg(pt.name, ' & ' order by pt.name) from partners pt join unnest(pid, pteam) as u(id, team) on u.id = pt.id where u.team = ids[j]));
    end if;
    nets[i] := nets[i] - amt;
    nets[j] := nets[j] + amt;
  end loop;

  select jsonb_build_object(
    'received',      coalesce(sum(pay.amount), 0),
    'received_cash', coalesce(sum(pay.amount) filter (where pay.method = 'cash'), 0),
    'orders',        count(distinct pay.sale_id))
  into mine
  from sale_payments pay
  where pay.business_id = p_biz and pay.paid_to = me and (p_from is null or pay.at > p_from);

  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name,
           'qty', qty, 'amount', amount, 'my_share', my_share) order by amount desc), '[]'::jsonb)
  into sold
  from (
    select si.product_id, max(si.name) as name, sum(si.qty) as qty,
           sum(si.price * si.qty) as amount, sum(si.price * si.qty * os.share) as my_share
    from sales s join sale_items si on si.sale_id = s.id
    join owner_shares os on os.owner = si.owner and os.partner_id = me
    where s.business_id = p_biz and (p_from is null or s.at > p_from)
    group by si.product_id
  ) t;

  -- my share of the money collected (items + any loan fees that are mine), and the fees part on its own
  select coalesce(sum(pay.amount * (coalesce(mv.v, 0) + case when s.fee_to = me then s.loan_fee else 0 end) / (tot.v + s.loan_fee)), 0),
         coalesce(sum(pay.amount * case when s.fee_to = me then s.loan_fee else 0 end / (tot.v + s.loan_fee)), 0)
  into due_me, fees_me
  from sale_payments pay
  join sales s on s.id = pay.sale_id
  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                     join owner_shares os on os.owner = si.owner and os.partner_id = me
                     where si.sale_id = pay.sale_id) mv on true
  where pay.business_id = p_biz and (p_from is null or pay.at > p_from);

  -- my share of what customers still owe (all time, not just this period)
  select coalesce(sum((tot.v + s.loan_fee - coalesce(pd.v, 0)) * (coalesce(mv.v, 0) + case when s.fee_to = me then s.loan_fee else 0 end) / (tot.v + s.loan_fee)), 0)
  into owing
  from sales s
  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = s.id) tot on true
  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                     join owner_shares os on os.owner = si.owner and os.partner_id = me
                     where si.sale_id = s.id) mv on true
  left join lateral (select sum(amount) as v from sale_payments where sale_id = s.id) pd on true
  where s.business_id = p_biz
    and tot.v + s.loan_fee - coalesce(pd.v, 0) > 0.005
    and (mv.v is not null or (s.fee_to = me and s.loan_fee > 0));

  return mine || jsonb_build_object(
    'me', me,
    'due', due_me,
    'fees', fees_me,
    'sold_value', coalesce((select sum((e ->> 'my_share')::numeric) from jsonb_array_elements(sold) e), 0),
    'outstanding', owing,
    'sold', sold,
    'pays', pays);
end $$;

-- ---------------------------------------------------------------- who may call what
-- Functions are closed to everyone first, then opened one by one for signed-in people.
revoke execute on all functions in schema busynes from public, anon, authenticated;

-- Rule helpers (the row level security rules call these as the signed-in person; they only describe that person).
grant execute on function my_member(uuid), my_role(uuid), my_members(), has_role(uuid, text[]),
                          sees_whole_sale(bigint), sale_has_my_items(bigint) to authenticated;
-- Actions and reports.
grant execute on function
  claim_memberships(), my_businesses(), create_business(text, text, text), update_business(uuid, text, text, text, boolean),
  delete_business(uuid, text), list_members(uuid), my_groups(uuid),
  invite_member(uuid, text, text, text, text, numeric), update_member(uuid, text, text, text),
  remove_member(uuid, text), leave_business(uuid), set_group_shares(uuid, text, jsonb), delete_group(uuid, text),
  add_product(uuid, text, numeric, text, boolean), update_product(text, text, numeric, boolean, boolean),
  add_stock_move(uuid, text, text, int), stock_levels(uuid), mark_settled(uuid),
  record_sale(uuid, jsonb, text, text, text, numeric, date, bigint, numeric, text),
  record_payment(bigint, numeric, text, text), set_sale_due(bigint, date), delete_sale(bigint),
  my_debts(uuid), sales_timeline(uuid, int),
  create_order(uuid, text, jsonb, text, timestamptz, boolean, numeric), cancel_order(bigint), claim_order(bigint, boolean),
  send_message(uuid, text), mark_notifications_read(uuid, bigint), ping_partner(text, text), set_my_phone(text),
  save_push_subscription(text, text, text), remove_push_subscription(text), my_money(uuid, timestamptz)
to authenticated;
-- Not callable from the app at all: new_id, notify, notify_all, sale_outstanding, send_due_reminders.

-- The push sender (an Edge Function using the service_role key) reads who to notify and removes dead phones.
grant usage on schema busynes to service_role;
grant select on partners, businesses to service_role;
grant select, delete on push_subscriptions to service_role;
