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
-- A loan fee is what the lender charges on top of the drinks. It belongs to fee_to, not to the owners of the drinks.
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

alter table orders add column if not exists claimed_by text references partners(id);
alter table orders add column if not exists claimed_at timestamptz;
alter table orders add column if not exists loan boolean not null default false;   -- lent out, to be paid back later
-- The fee for a loan order is the lender's business: only they can read it.
create table if not exists order_fees (
  order_id bigint primary key references orders(id) on delete cascade,
  fee      numeric(10,2) not null check (fee > 0),
  fee_to   text not null references partners(id)
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
grant select on partners, owner_shares, products, stock_moves, sale_items, settlements,
  sale_payments, orders, notifications, messages, order_fees to authenticated;
-- Partners read sales through sales_timeline(). Directly they may only see the plain columns,
-- never the due date, loan fee or fee owner (which would show who owes whom what).
revoke select on sales from authenticated;
grant select (id, at, paid_to, method, note, recorded_by) on sales to authenticated;
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
alter table order_fees         enable row level security;

drop policy if exists payments_read on sale_payments;
create policy payments_read on sale_payments for select to authenticated using (sees_whole_sale(sale_id));
drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated using (my_partner() is not null);
drop policy if exists notif_read on notifications;
create policy notif_read on notifications for select to authenticated using (partner_id = my_partner());
drop policy if exists fees_read on order_fees;
create policy fees_read on order_fees for select to authenticated using (fee_to = my_partner());
drop policy if exists messages_read on messages;
create policy messages_read on messages for select to authenticated using (my_partner() is not null);

-- ---------------------------------------------------------------- actions
-- Record a sale. Prices come from the products table, not from the phone.
-- p_items: [{"product_id": "heineken", "qty": 2}, ...]
-- p_paid:  how much was paid now (null = paid in full). Less than the total = on credit.
-- p_due:   the date the rest was promised. p_order: an open order this sale fulfils.
-- p_fee:   a loan fee charged on top of the drinks. It is added to what the customer owes and belongs
--          to p_fee_to (default: whoever records the sale), not to the owners of the drinks.
drop function if exists record_sale(jsonb, text, text, text);
drop function if exists record_sale(jsonb, text, text, text, numeric, date, bigint);
create or replace function record_sale(p_items jsonb, p_paid_to text, p_method text, p_note text default '',
                                       p_paid numeric default null, p_due date default null, p_order bigint default null,
                                       p_fee numeric default 0, p_fee_to text default null)
returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner();
  my_name text;
  paid_name text;
  new_id bigint;
  it jsonb;
  p products%rowtype;
  items_total numeric := 0;
  total numeric;
  fee numeric := coalesce(p_fee, 0);
  fee_who text := coalesce(p_fee_to, my_partner());
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
  if fee < 0 or fee > 100000 then raise exception 'That loan fee does not look right'; end if;
  if fee > 0 and not exists (select 1 from partners where id = fee_who) then raise exception 'Unknown partner for the loan fee'; end if;
  select name into my_name from partners where id = me;
  insert into sales (paid_to, method, note, recorded_by, loan_fee, fee_to)
    values (p_paid_to, p_method, cust, me, fee, case when fee > 0 then fee_who end)
    returning id into new_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id';
    if not found then raise exception 'Unknown product %', it ->> 'product_id'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    insert into sale_items (sale_id, product_id, name, owner, price, qty)
      values (new_id, p.id, p.name, p.owner, p.price, (it ->> 'qty')::int);
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
    insert into sale_payments (sale_id, amount, method, paid_to, recorded_by) values (new_id, paid, p_method, p_paid_to, me);
  end if;
  if p_order is not null then
    update orders set status = 'done', sale_id = new_id where id = p_order and status = 'open';
  end if;

  -- Tell everyone else, so whoever is free can deal with it. Amounts, fees and who owes stay private:
  -- only the partner holding the money gets figures.
  select name into paid_name from partners where id = p_paid_to;
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
      perform notify(r.id, 'sale', 'Your stock sold: ' || mine,
        'Sold by ' || my_name || case when paid > 0 then ' · money with ' || paid_name else '' end, new_id::text);
    else
      perform notify(r.id, 'sale', my_name || ' sold ' || lines,
        case when paid > 0 then 'Money with ' || paid_name else '' end, new_id::text);
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
       + coalesce((select loan_fee from sales where id = p_sale), 0)
       - coalesce((select sum(amount) from sale_payments where sale_id = p_sale), 0)
$$;

-- Sales that still have money owing, for the partner who recorded or collects them.
-- total includes any loan fee; loan_fee is shown separately.
drop function if exists my_debts();
create or replace function my_debts()
returns table (sale_id bigint, at timestamptz, customer text, items text, total numeric, paid numeric,
               outstanding numeric, due_on date, paid_to text, recorded_by text, loan_fee numeric)
language sql stable security definer set search_path = busynes as $$
  select s.id, s.at, s.note,
         (select string_agg(i.qty || ' × ' || i.name, ', ' order by i.id) from sale_items i where i.sale_id = s.id),
         t.total + s.loan_fee, coalesce(p.paid, 0), t.total + s.loan_fee - coalesce(p.paid, 0), s.due_on, s.paid_to, s.recorded_by, s.loan_fee
  from sales s
  join lateral (select sum(price * qty) as total from sale_items where sale_id = s.id) t on true
  left join lateral (select sum(amount) as paid from sale_payments where sale_id = s.id) p on true
  where my_partner() is not null
    and (s.paid_to = my_partner() or s.recorded_by = my_partner())
    and t.total + s.loan_fee - coalesce(p.paid, 0) > 0.005
  order by s.due_on nulls last, s.at
$$;

-- Orders waiting to be sold.
-- p_at:   when the order came in (null = now), so an order you forgot to write down can be added later.
-- p_loan: the drinks are lent out and paid back later. p_fee: the fee you plan to charge; only you can see it.
drop function if exists create_order(text, jsonb, text);
drop function if exists create_order(text, jsonb, text, timestamptz);
create or replace function create_order(p_customer text, p_items jsonb, p_note text default '', p_at timestamptz default null,
                                        p_loan boolean default false, p_fee numeric default 0) returns bigint
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner();
  my_name text; new_id bigint; it jsonb; p products%rowtype;
  clean jsonb := '[]'::jsonb; lines text := '';
  loan boolean := coalesce(p_loan, false);
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'An order needs at least one item'; end if;
  if p_at is not null and p_at > now() + interval '5 minutes' then raise exception 'The order date can''t be in the future'; end if;
  if coalesce(p_fee, 0) < 0 or coalesce(p_fee, 0) > 100000 then raise exception 'That loan fee does not look right'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id';
    if not found then raise exception 'Unknown product %', it ->> 'product_id'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    clean := clean || jsonb_build_object('product_id', p.id, 'name', p.name, 'qty', (it ->> 'qty')::int);
    lines := lines || case when lines = '' then '' else ', ' end || (it ->> 'qty') || ' × ' || p.name;
  end loop;
  insert into orders (at, customer, items, note, created_by, loan)
    values (coalesce(p_at, now()), left(coalesce(p_customer, ''), 80), clean, left(coalesce(p_note, ''), 200), me, loan)
    returning id into new_id;
  if loan and coalesce(p_fee, 0) > 0 then
    insert into order_fees (order_id, fee, fee_to) values (new_id, p_fee, me);
  end if;
  select name into my_name from partners where id = me;
  perform notify_all('order', case when loan then 'New loan order' else 'New order' end ||
                     case when coalesce(p_customer, '') <> '' then ' from ' || left(p_customer, 40) else '' end,
                     lines || ' · added by ' || my_name, new_id::text, me);
  return new_id;
end $$;

create or replace function cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = busynes as $$
begin
  if my_partner() is null then raise exception 'Not a BusyNes partner'; end if;
  update orders set status = 'cancelled' where id = p_id and status = 'open';
end $$;

-- The team's sales trail, newest first. Everyone sees WHAT was sold, WHEN, by WHOM, where the money
-- went and the note. Prices, totals, loan fees, what is still owed and due dates are only filled in
-- for sales the caller recorded or collected (and prices for the caller's own products).
drop function if exists sales_timeline(int);
create or replace function sales_timeline(p_limit int default 300)
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
                                                        where os.owner = i.owner and os.partner_id = my_partner())
                                then i.price end) order by i.id)
          from sale_items i where i.sale_id = s.id)
  from sales s
  cross join lateral (select (s.paid_to = my_partner() or s.recorded_by = my_partner()) as whole) w
  join lateral (select sum(price * qty) as total from sale_items where sale_id = s.id) t on true
  left join lateral (select sum(amount) as paid from sale_payments where sale_id = s.id) p on true
  where my_partner() is not null
  order by s.at desc, s.id desc
  limit least(greatest(coalesce(p_limit, 300), 1), 500)
$$;

-- "I'll take it" on an open order, so two people don't both chase it. p_take = false lets go again.
create or replace function claim_order(p_id bigint, p_take boolean default true) returns void
language plpgsql security definer set search_path = busynes as $$
declare
  me text := my_partner(); my_name text; o orders%rowtype; what text;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  select * into o from orders where id = p_id for update;
  if not found or o.status <> 'open' then raise exception 'That order is no longer open'; end if;
  select name into my_name from partners where id = me;
  what := coalesce(nullif(o.customer, ''), 'An order') || ' · ' ||
          coalesce((select string_agg((e ->> 'qty') || ' × ' || (e ->> 'name'), ', ') from jsonb_array_elements(o.items) e), '');
  if p_take then
    if o.claimed_by is not null and o.claimed_by <> me then
      raise exception '% is already on this order', (select name from partners where id = o.claimed_by);
    end if;
    update orders set claimed_by = me, claimed_at = now() where id = p_id;
    perform notify_all('order', my_name || ' is on it', what, p_id::text, me);
  else
    if o.claimed_by is distinct from me then raise exception 'You are not on this order'; end if;
    update orders set claimed_by = null, claimed_at = null where id = p_id;
    perform notify_all('order', my_name || ' can''t take the order after all', what, p_id::text, me);
  end if;
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
-- Money counts when it is actually collected. Each payment is shared out in proportion to what the sale
-- was made of: the owners of the drinks get their share of the drinks, and whoever charged a loan fee
-- gets the fee's share. So a credit sale only moves money as the customer pays it back.
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
  due_me numeric;
  fees_me numeric;
  pid text[]; pteam text[]; my_team text;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;

  -- everyone's balance = money received - their share of the money collected
  select array_agg(x.id order by x.id), array_agg(x.net order by x.id) into ids, nets
  from (
    select p.id,
      coalesce((select sum(pay.amount) from sale_payments pay
                where pay.paid_to = p.id and (p_from is null or pay.at > p_from)), 0)
      - coalesce((select sum(pay.amount * (coalesce(mv.v, 0) + case when s.fee_to = p.id then s.loan_fee else 0 end) / (tot.v + s.loan_fee))
                  from sale_payments pay
                  join sales s on s.id = pay.sale_id
                  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
                  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                                     join owner_shares os on os.owner = si.owner and os.partner_id = p.id
                                     where si.sale_id = pay.sale_id) mv on true
                  where (p_from is null or pay.at > p_from)), 0) as net
    from partners p
  ) x;

  -- Partners who co-own the same stock (like Vusi and Dokotela with the beers) settle up as ONE team:
  -- their balances are added together, so you pay the team once, to either of them.
  with recursive edges as (
    select a.partner_id as a, b.partner_id as b from owner_shares a join owner_shares b on a.owner = b.owner
  ), reach(p, q) as (
    select a, b from edges
    union
    select r.p, e.b from reach r join edges e on e.a = r.q
  )
  select array_agg(pt.id order by pt.id), array_agg(coalesce(tm.team, pt.id) order by pt.id)
  into pid, pteam
  from partners pt left join (select p, min(q) as team from reach group by p) tm on tm.p = pt.id;
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

  -- my share of the money collected (drinks + any loan fees that are mine), and the fees part on its own
  select coalesce(sum(pay.amount * (coalesce(mv.v, 0) + case when s.fee_to = me then s.loan_fee else 0 end) / (tot.v + s.loan_fee)), 0),
         coalesce(sum(pay.amount * case when s.fee_to = me then s.loan_fee else 0 end / (tot.v + s.loan_fee)), 0)
  into due_me, fees_me
  from sale_payments pay
  join sales s on s.id = pay.sale_id
  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = pay.sale_id) tot on true
  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                     join owner_shares os on os.owner = si.owner and os.partner_id = me
                     where si.sale_id = pay.sale_id) mv on true
  where (p_from is null or pay.at > p_from);

  -- my share of what customers still owe (all time, not just this period)
  select coalesce(sum((tot.v + s.loan_fee - coalesce(pd.v, 0)) * (coalesce(mv.v, 0) + case when s.fee_to = me then s.loan_fee else 0 end) / (tot.v + s.loan_fee)), 0)
  into owing
  from sales s
  join lateral (select sum(si.price * si.qty) as v from sale_items si where si.sale_id = s.id) tot on true
  left join lateral (select sum(si.price * si.qty * os.share) as v from sale_items si
                     join owner_shares os on os.owner = si.owner and os.partner_id = me
                     where si.sale_id = s.id) mv on true
  left join lateral (select sum(amount) as v from sale_payments where sale_id = s.id) pd on true
  where tot.v + s.loan_fee - coalesce(pd.v, 0) > 0.005
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

-- Only signed-in users may call the functions.
revoke all on function record_sale(jsonb, text, text, text, numeric, date, bigint, numeric, text) from public, anon;
revoke all on function delete_sale(bigint) from public, anon;
revoke all on function stock_levels() from public, anon;
revoke all on function my_money(timestamptz) from public, anon;
grant execute on function record_sale(jsonb, text, text, text, numeric, date, bigint, numeric, text) to authenticated;
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
revoke all on function create_order(text, jsonb, text, timestamptz, boolean, numeric) from public, anon;
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
grant execute on function create_order(text, jsonb, text, timestamptz, boolean, numeric) to authenticated;
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

revoke all on function sales_timeline(int) from public, anon;
revoke all on function claim_order(bigint, boolean) from public, anon;
grant execute on function sales_timeline(int) to authenticated;
grant execute on function claim_order(bigint, boolean) to authenticated;
