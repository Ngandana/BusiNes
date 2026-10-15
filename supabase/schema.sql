-- BusyNes database setup for Supabase.
-- Run this whole file once in Supabase: SQL Editor > New query > paste > Run.
-- Then run seed.sql (after putting in your three email addresses).
--
-- Privacy model
--   * Everyone signed in as a partner sees products, stock levels and settle-ups.
--   * Sales are hidden by row-level security. A partner only sees a sale if the
--     money went to them, they recorded it, or it contains their own products
--     (and then only their own item lines).
--   * Money totals come from my_money(), which works out everybody's balance on
--     the server but only returns the caller's own numbers and the payments
--     that involve the caller.

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

-- ---------------------------------------------------------------- tables
create table if not exists partners (
  id    text primary key,                 -- 'sibabalo', 'vusi', 'dokotela'
  name  text not null,
  email text unique                       -- the email they sign in with
);

-- Which partners own which group of products, and their share of it.
create table if not exists owner_shares (
  owner      text not null,               -- product owner group, e.g. 'sibabalo', 'beers'
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
  kind       text not null check (kind in ('add','count')),  -- delivery, or fridge count
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
create index if not exists sale_items_sale_idx on sale_items(sale_id);
create index if not exists sales_at_idx on sales(at desc);

create table if not exists settlements (
  id  bigint generated always as identity primary key,
  at  timestamptz not null default now(),
  by  text references partners(id)
);


-- ---------------------------------------------------------------- credit, orders, alerts, chat
alter table partners add column if not exists phone text;             -- for the Call / WhatsApp buttons
alter table sales    add column if not exists due_on date;            -- when an unpaid balance is promised back

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
create index if not exists sale_payments_sale_idx on sale_payments(sale_id);

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

-- One row per person to tell. Written only by the functions below, so what each partner
-- is told respects the same privacy rules as everything else.
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  partner_id text not null references partners(id),
  at         timestamptz not null default now(),
  kind       text not null,                        -- sale, credit, payment, order, reminder, chat, stock, call
  title      text not null,
  body       text not null default '',
  ref        text,
  read_at    timestamptz
);
create index if not exists notifications_partner_idx on notifications(partner_id, id desc);

create table if not exists messages (
  id   bigint generated always as identity primary key,
  at   timestamptz not null default now(),
  from_partner text not null references partners(id),
  body text not null check (length(body) between 1 and 500)
);

-- Phones that asked for notifications (Web Push). Never readable from the app directly.
create table if not exists push_subscriptions (
  id         bigint generated always as identity primary key,
  partner_id text not null references partners(id),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers
-- The partner id of whoever is signed in, from the email on their login.
create or replace function my_partner() returns text
language sql stable security definer set search_path = busynes as $$
  select id from partners where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- True when the signed-in partner may see the whole sale.
create or replace function sees_whole_sale(p_sale bigint) returns boolean
language sql stable security definer set search_path = busynes as $$
  select exists (select 1 from sales s where s.id = p_sale
                 and (s.paid_to = my_partner() or s.recorded_by = my_partner()))
$$;

-- True when the sale contains at least one product the signed-in partner owns.
create or replace function sale_has_my_items(p_sale bigint) returns boolean
language sql stable security definer set search_path = busynes as $$
  select exists (select 1 from sale_items si
                 join owner_shares os on os.owner = si.owner
                 where si.sale_id = p_sale and os.partner_id = my_partner())
$$;

-- ---------------------------------------------------------------- row level security
alter table partners     enable row level security;
alter table owner_shares enable row level security;
alter table products     enable row level security;
alter table stock_moves  enable row level security;
alter table sales        enable row level security;
alter table sale_items   enable row level security;
alter table settlements  enable row level security;

drop policy if exists partners_read on partners;
create policy partners_read on partners for select to authenticated using (my_partner() is not null);

drop policy if exists shares_read on owner_shares;
create policy shares_read on owner_shares for select to authenticated using (my_partner() is not null);

drop policy if exists products_read on products;
create policy products_read on products for select to authenticated using (my_partner() is not null);
drop policy if exists products_insert on products;
create policy products_insert on products for insert to authenticated with check (my_partner() is not null);
drop policy if exists products_update on products;
create policy products_update on products for update to authenticated using (my_partner() is not null) with check (my_partner() is not null);
-- Partners may change a product's name, price, order and visibility, but not its owner:
-- otherwise anyone could move another partner's drinks (and their money) to themselves.
revoke update on products from authenticated, anon;
grant update (name, price, sort, hidden) on products to authenticated;
grant select on partners, owner_shares, products, stock_moves, sales, sale_items, settlements,
  sale_payments, orders, notifications, messages to authenticated;
grant insert on products, stock_moves, settlements to authenticated;
grant usage on all sequences in schema busynes to authenticated;

drop policy if exists moves_read on stock_moves;
create policy moves_read on stock_moves for select to authenticated using (my_partner() is not null);
drop policy if exists moves_insert on stock_moves;
create policy moves_insert on stock_moves for insert to authenticated with check (by = my_partner());

-- Sales: read only what concerns you. Writes go through record_sale / delete_sale.
drop policy if exists sales_read on sales;
create policy sales_read on sales for select to authenticated
  using (paid_to = my_partner() or recorded_by = my_partner() or sale_has_my_items(id));

drop policy if exists items_read on sale_items;
create policy items_read on sale_items for select to authenticated
  using (sees_whole_sale(sale_id)
         or owner in (select owner from owner_shares where partner_id = my_partner()));

drop policy if exists settle_read on settlements;
create policy settle_read on settlements for select to authenticated using (my_partner() is not null);
drop policy if exists settle_insert on settlements;
create policy settle_insert on settlements for insert to authenticated with check (by = my_partner());


alter table sale_payments      enable row level security;
alter table orders             enable row level security;
alter table notifications      enable row level security;
alter table messages           enable row level security;
alter table push_subscriptions enable row level security;   -- no policies: only the functions touch it

drop policy if exists payments_read on sale_payments;
create policy payments_read on sale_payments for select to authenticated using (sees_whole_sale(sale_id));
drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated using (my_partner() is not null);
drop policy if exists notif_read on notifications;
create policy notif_read on notifications for select to authenticated using (partner_id = my_partner());
drop policy if exists messages_read on messages;
create policy messages_read on messages for select to authenticated using (my_partner() is not null);

-- ---------------------------------------------------------------- actions
-- Record a sale. Prices come from the products table, not from the phone.
-- p_items: [{"product_id": "heineken", "qty": 2}, ...]
-- p_paid:  how much was paid now (null = paid in full). Less than the total = on credit.
-- p_due:   the date the rest was promised. p_order: an open order this sale fulfils.
drop function if exists record_sale(jsonb, text, text, text);
create or replace function record_sale(p_items jsonb, p_paid_to text, p_method text, p_note text default '',
                                       p_paid numeric default null, p_due date default null, p_order bigint default null)
returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner();
  my_name text;
  new_id bigint;
  it jsonb;
  p products%rowtype;
  total numeric := 0;
  paid numeric;
  lines text := '';
  mine text;
  r record;
  qty_left int;
  cust text := left(coalesce(p_note, ''), 120);
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  select name into my_name from partners where id = me;
  insert into sales (paid_to, method, note, recorded_by)
    values (p_paid_to, p_method, cust, me)
    returning id into new_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id';
    if not found then raise exception 'Unknown product %', it ->> 'product_id'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    insert into sale_items (sale_id, product_id, name, owner, price, qty)
      values (new_id, p.id, p.name, p.owner, p.price, (it ->> 'qty')::int);
    total := total + p.price * (it ->> 'qty')::int;
    lines := lines || case when lines = '' then '' else ', ' end || (it ->> 'qty') || ' × ' || p.name;
  end loop;

  paid := coalesce(p_paid, total);
  if paid < 0 or paid > total then raise exception 'The amount paid must be between R0 and the total'; end if;
  if paid < total then
    if cust = '' then raise exception 'Put the customer''s name on a sale that is not paid in full'; end if;
    update sales set due_on = p_due where id = new_id;
  end if;
  if paid > 0 then
    insert into sale_payments (sale_id, amount, method, paid_to, recorded_by) values (new_id, paid, p_method, p_paid_to, me);
  end if;
  if p_order is not null then
    update orders set status = 'done', sale_id = new_id where id = p_order and status = 'open';
  end if;

  -- Tell the others, each only what they are allowed to know.
  for r in select id from partners where id <> me loop
    mine := (select string_agg(si.qty || ' × ' || si.name, ', ')
             from sale_items si
             where si.sale_id = new_id
               and exists (select 1 from owner_shares os where os.owner = si.owner and os.partner_id = r.id));
    if r.id = p_paid_to then
      perform notify(r.id, case when paid < total then 'credit' else 'sale' end,
        my_name || case when paid < total then ' put a sale on credit with you' else ' recorded a sale paid to you' end,
        lines || ' · R' || total || case when paid < total then ' · owes R' || (total - paid) ||
          case when p_due is not null then ' by ' || to_char(p_due, 'DD Mon') else '' end || ' (' || cust || ')'
          else '' end,
        new_id::text);
    elsif mine is not null then
      perform notify(r.id, 'sale', 'Your stock sold', mine, new_id::text);
    end if;
  end loop;

  -- Running low? Tell everyone once, when a sale pushes a product down to 3 or fewer.
  for r in select si.product_id, max(si.name) as name, sum(si.qty)::int as sold
           from sale_items si where si.sale_id = new_id group by si.product_id loop
    select qty into qty_left from stock_levels() where product_id = r.product_id;
    if qty_left is not null and qty_left <= 3 and qty_left + r.sold > 3 then
      perform notify_all('stock', 'Running low: ' || r.name, qty_left || ' left', r.product_id);
    end if;
  end loop;
  return new_id;
end $$;

-- Record money coming in on a sale that was not paid in full.
create or replace function record_payment(p_sale bigint, p_amount numeric, p_method text default 'cash', p_paid_to text default null)
returns void
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner();
  my_name text;
  s sales%rowtype;
  left_over numeric;
  r record;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if not sees_whole_sale(p_sale) then raise exception 'You can only take payments on sales you recorded or collect'; end if;
  if p_method not in ('cash','transfer') then raise exception 'Payment must be cash or transfer'; end if;
  select * into s from sales where id = p_sale;
  left_over := sale_outstanding(p_sale);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above R0'; end if;
  if p_amount > left_over + 0.005 then raise exception 'That is more than what is still owed (R%)', round(left_over, 2); end if;
  insert into sale_payments (sale_id, amount, method, paid_to, recorded_by)
    values (p_sale, p_amount, p_method, coalesce(p_paid_to, me), me);
  select name into my_name from partners where id = me;
  for r in select id from partners where id <> me loop
    if r.id in (s.paid_to, s.recorded_by) or exists (
         select 1 from sale_items si join owner_shares os on os.owner = si.owner
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
begin
  if my_partner() is null or not sees_whole_sale(p_sale) then raise exception 'Not your sale'; end if;
  update sales set due_on = p_due where id = p_sale;
end $$;

-- Delete a sale (to fix a mistake). Only whoever recorded it or received the money.
create or replace function delete_sale(p_id bigint) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  delete from sales where id = p_id
    and (recorded_by = my_partner() or paid_to = my_partner());
  if not found then raise exception 'You can only delete sales you recorded or were paid for'; end if;
end $$;

-- Stock on hand for every product: last fridge count + later deliveries - later sales.
create or replace function stock_levels() returns table (product_id text, qty int)
language sql stable security definer set search_path = busynes as $$
  with last_count as (
    select distinct on (m.product_id) m.product_id, m.qty, m.at
    from stock_moves m where m.kind = 'count'
    order by m.product_id, m.at desc, m.id desc
  )
  select pr.id,
    (coalesce(lc.qty, 0)
     + coalesce((select sum(m.qty) from stock_moves m
                 where m.product_id = pr.id and m.kind = 'add'
                   and (lc.at is null or m.at > lc.at)), 0)
     - coalesce((select sum(si.qty) from sale_items si join sales s on s.id = si.sale_id
                 where si.product_id = pr.id and (lc.at is null or s.at > lc.at)), 0))::int
  from products pr
  left join last_count lc on lc.product_id = pr.id
  where my_partner() is not null
$$;

-- Internal helpers (not callable from the app).
create or replace function notify(p_partner text, p_kind text, p_title text, p_body text default '', p_ref text default null)
returns void language sql security definer set search_path = busynes as $$
  insert into notifications (partner_id, kind, title, body, ref)
  values (p_partner, p_kind, left(p_title, 140), left(coalesce(p_body, ''), 300), p_ref);
$$;
create or replace function notify_all(p_kind text, p_title text, p_body text default '', p_ref text default null, p_except text default null)
returns void language sql security definer set search_path = busynes as $$
  insert into notifications (partner_id, kind, title, body, ref)
  select id, p_kind, left(p_title, 140), left(coalesce(p_body, ''), 300), p_ref
  from partners where p_except is null or id <> p_except;
$$;
create or replace function sale_outstanding(p_sale bigint) returns numeric
language sql stable security definer set search_path = busynes as $$
  select coalesce((select sum(price * qty) from sale_items where sale_id = p_sale), 0)
       - coalesce((select sum(amount) from sale_payments where sale_id = p_sale), 0)
$$;

-- Sales that still have money owing, for the partner who recorded or collects them.
create or replace function my_debts()
returns table (sale_id bigint, at timestamptz, customer text, items text, total numeric, paid numeric,
               outstanding numeric, due_on date, paid_to text, recorded_by text)
language sql stable security definer set search_path = busynes as $$
  select s.id, s.at, s.note,
         (select string_agg(i.qty || ' × ' || i.name, ', ' order by i.id) from sale_items i where i.sale_id = s.id),
         t.total, coalesce(p.paid, 0), t.total - coalesce(p.paid, 0), s.due_on, s.paid_to, s.recorded_by
  from sales s
  join lateral (select sum(price * qty) as total from sale_items where sale_id = s.id) t on true
  left join lateral (select sum(amount) as paid from sale_payments where sale_id = s.id) p on true
  where my_partner() is not null
    and (s.paid_to = my_partner() or s.recorded_by = my_partner())
    and t.total - coalesce(p.paid, 0) > 0.005
  order by s.due_on nulls last, s.at
$$;

-- Orders waiting to be sold.
create or replace function create_order(p_customer text, p_items jsonb, p_note text default '') returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner();
  my_name text; new_id bigint; it jsonb; p products%rowtype;
  clean jsonb := '[]'::jsonb; lines text := '';
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'An order needs at least one item'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id';
    if not found then raise exception 'Unknown product %', it ->> 'product_id'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    clean := clean || jsonb_build_object('product_id', p.id, 'name', p.name, 'qty', (it ->> 'qty')::int);
    lines := lines || case when lines = '' then '' else ', ' end || (it ->> 'qty') || ' × ' || p.name;
  end loop;
  insert into orders (customer, items, note, created_by)
    values (left(coalesce(p_customer, ''), 80), clean, left(coalesce(p_note, ''), 200), me)
    returning id into new_id;
  select name into my_name from partners where id = me;
  perform notify_all('order', 'New order' || case when coalesce(p_customer, '') <> '' then ' from ' || left(p_customer, 40) else '' end,
                     lines || ' · added by ' || my_name, new_id::text, me);
  return new_id;
end $$;

create or replace function cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  if my_partner() is null then raise exception 'Not a BusyNes partner'; end if;
  update orders set status = 'cancelled' where id = p_id and status = 'open';
end $$;

-- The group chat (a side feature) and the notification inbox.
create or replace function send_message(p_body text) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_partner(); my_name text; b text := btrim(coalesce(p_body, ''));
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if b = '' then raise exception 'Type a message first'; end if;
  insert into messages (from_partner, body) values (me, left(b, 500));
  select name into my_name from partners where id = me;
  perform notify_all('chat', my_name, left(b, 120), null, me);
end $$;

create or replace function mark_notifications_read(p_up_to bigint default null) returns void
language sql security definer set search_path = busynes as $$
  update notifications set read_at = now()
  where partner_id = my_partner() and read_at is null and (p_up_to is null or id <= p_up_to)
$$;

-- "Call me": a pushed alert telling someone to ring you.
create or replace function ping_partner(p_to text, p_text text default 'Please call me') returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_partner(); my_name text;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  select name into my_name from partners where id = me;
  perform notify(p_to, 'call', my_name || ' wants you to call', left(coalesce(p_text, ''), 100), me);
end $$;

create or replace function set_my_phone(p_phone text) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_partner(); clean text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if clean <> '' and length(regexp_replace(clean, '[^0-9]', '', 'g')) not between 9 and 15 then
    raise exception 'That does not look like a phone number';
  end if;
  update partners set phone = nullif(clean, '') where id = me;
end $$;

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = busynes as $$
declare me text := my_partner();
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  insert into push_subscriptions (partner_id, endpoint, p256dh, auth) values (me, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set partner_id = excluded.partner_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
create or replace function remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = busynes as $$
  delete from push_subscriptions where endpoint = p_endpoint and partner_id = my_partner()
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

-- The signed-in partner's own money for a period (p_from = null means all time).
-- Returns only their numbers, plus the settle-up payments they are part of.
-- Money counts when it is actually collected: each payment is shared between the owners of
-- the items on that sale, so a credit sale only moves money as the customer pays it back.
create or replace function my_money(p_from timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = busynes as $$
declare
  me text := my_partner();
  ids text[]; nets numeric[];
  i int; j int; amt numeric;
  pays jsonb := '[]'::jsonb;
  mine jsonb;
  sold jsonb;
  owing numeric;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;

  -- everyone's balance = money received - their share of the money collected
  select array_agg(x.id order by x.id), array_agg(x.net order by x.id) into ids, nets
  from (
    select p.id,
      coalesce((select sum(pay.amount) from sale_payments pay
                where pay.paid_to = p.id and (p_from is null or pay.at > p_from)), 0)
      - coalesce((select sum(pay.amount * mine_v.v / tot.v)
                  from sale_payments pay
                  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
                  join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                                join owner_shares os on os.owner = si.owner and os.partner_id = p.id
                                where si.sale_id = pay.sale_id) mine_v on true
                  where mine_v.v is not null and (p_from is null or pay.at > p_from)), 0) as net
    from partners p
  ) x;

  -- pair whoever holds the most extra with whoever is shortest, until all even
  loop
    i := null; j := null;
    for k in 1 .. coalesce(array_length(ids, 1), 0) loop
      if nets[k] > 0.005 and (i is null or nets[k] > nets[i]) then i := k; end if;
      if nets[k] < -0.005 and (j is null or nets[k] < nets[j]) then j := k; end if;
    end loop;
    exit when i is null or j is null;
    amt := least(nets[i], -nets[j]);
    if ids[i] = me or ids[j] = me then
      pays := pays || jsonb_build_object('from', ids[i], 'to', ids[j], 'amount', round(amt, 2));
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
  where pay.paid_to = me and (p_from is null or pay.at > p_from);

  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name,
           'qty', qty, 'amount', amount, 'my_share', my_share) order by amount desc), '[]'::jsonb)
  into sold
  from (
    select si.product_id, max(si.name) as name, sum(si.qty) as qty,
           sum(si.price * si.qty) as amount, sum(si.price * si.qty * os.share) as my_share
    from sales s join sale_items si on si.sale_id = s.id
    join owner_shares os on os.owner = si.owner and os.partner_id = me
    where (p_from is null or s.at > p_from)
    group by si.product_id
  ) t;

  -- my share of what customers still owe on sales (all time, not just this period)
  select coalesce(sum((tot.v - coalesce(pd.v, 0)) * mine_v.v / tot.v), 0) into owing
  from sales s
  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = s.id) tot on true
  join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                join owner_shares os on os.owner = si.owner and os.partner_id = me
                where si.sale_id = s.id) mine_v on true
  left join lateral (select sum(amount) as v from sale_payments where sale_id = s.id) pd on true
  where mine_v.v is not null and tot.v - coalesce(pd.v, 0) > 0.005;

  return mine || jsonb_build_object(
    'me', me,
    'due', coalesce((select sum(pay.amount * mine_v.v / tot.v)
                     from sale_payments pay
                     join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
                     join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                                   join owner_shares os on os.owner = si.owner and os.partner_id = me
                                   where si.sale_id = pay.sale_id) mine_v on true
                     where mine_v.v is not null and (p_from is null or pay.at > p_from)), 0),
    'sold_value', coalesce((select sum((e ->> 'my_share')::numeric) from jsonb_array_elements(sold) e), 0),
    'outstanding', owing,
    'sold', sold,
    'pays', pays);
end $$;

-- Only signed-in users may call the functions.
revoke all on function record_sale(jsonb, text, text, text, numeric, date, bigint) from public, anon;
revoke all on function delete_sale(bigint) from public, anon;
revoke all on function stock_levels() from public, anon;
revoke all on function my_money(timestamptz) from public, anon;
grant execute on function record_sale(jsonb, text, text, text, numeric, date, bigint) to authenticated;
grant execute on function delete_sale(bigint) to authenticated;
grant execute on function stock_levels() to authenticated;
grant execute on function my_money(timestamptz) to authenticated;
revoke all on function my_partner() from public, anon;
revoke all on function sees_whole_sale(bigint) from public, anon;
revoke all on function sale_has_my_items(bigint) from public, anon;
grant execute on function my_partner() to authenticated;
grant execute on function sees_whole_sale(bigint) to authenticated;
grant execute on function sale_has_my_items(bigint) to authenticated;

-- New actions. Internal helpers are not callable from the app at all.
revoke all on function record_payment(bigint, numeric, text, text) from public, anon;
revoke all on function set_sale_due(bigint, date) from public, anon;
revoke all on function my_debts() from public, anon;
revoke all on function create_order(text, jsonb, text) from public, anon;
revoke all on function cancel_order(bigint) from public, anon;
revoke all on function send_message(text) from public, anon;
revoke all on function mark_notifications_read(bigint) from public, anon;
revoke all on function ping_partner(text, text) from public, anon;
revoke all on function set_my_phone(text) from public, anon;
revoke all on function save_push_subscription(text, text, text) from public, anon;
revoke all on function remove_push_subscription(text) from public, anon;
revoke all on function notify(text, text, text, text, text) from public, anon, authenticated;
revoke all on function notify_all(text, text, text, text, text) from public, anon, authenticated;
revoke all on function sale_outstanding(bigint) from public, anon, authenticated;
revoke all on function send_due_reminders() from public, anon, authenticated;
grant execute on function record_payment(bigint, numeric, text, text) to authenticated;
grant execute on function set_sale_due(bigint, date) to authenticated;
grant execute on function my_debts() to authenticated;
grant execute on function create_order(text, jsonb, text) to authenticated;
grant execute on function cancel_order(bigint) to authenticated;
grant execute on function send_message(text) to authenticated;
grant execute on function mark_notifications_read(bigint) to authenticated;
grant execute on function ping_partner(text, text) to authenticated;
grant execute on function set_my_phone(text) to authenticated;
grant execute on function save_push_subscription(text, text, text) to authenticated;
grant execute on function remove_push_subscription(text) to authenticated;

-- The push sender (an Edge Function using the service_role key) reads subscriptions and removes dead ones.
grant usage on schema busynes to service_role;
grant select, delete on push_subscriptions to service_role;
