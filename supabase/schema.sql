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

-- ---------------------------------------------------------------- helpers
-- The partner id of whoever is signed in, from the email on their login.
create or replace function my_partner() returns text
language sql stable security definer set search_path = public as $$
  select id from partners where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- True when the signed-in partner may see the whole sale.
create or replace function sees_whole_sale(p_sale bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sales s where s.id = p_sale
                 and (s.paid_to = my_partner() or s.recorded_by = my_partner()))
$$;

-- True when the sale contains at least one product the signed-in partner owns.
create or replace function sale_has_my_items(p_sale bigint) returns boolean
language sql stable security definer set search_path = public as $$
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

-- ---------------------------------------------------------------- actions
-- Record a sale. Prices come from the products table, not from the phone.
-- p_items: [{"product_id": "heineken", "qty": 2}, ...]
create or replace function record_sale(p_items jsonb, p_paid_to text, p_method text, p_note text default '')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me text := my_partner();
  new_id bigint;
  it jsonb;
  p products%rowtype;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;
  insert into sales (paid_to, method, note, recorded_by)
    values (p_paid_to, p_method, left(coalesce(p_note, ''), 120), me)
    returning id into new_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = it ->> 'product_id';
    if not found then raise exception 'Unknown product %', it ->> 'product_id'; end if;
    if (it ->> 'qty')::int <= 0 then raise exception 'Quantity must be at least 1'; end if;
    insert into sale_items (sale_id, product_id, name, owner, price, qty)
      values (new_id, p.id, p.name, p.owner, p.price, (it ->> 'qty')::int);
  end loop;
  return new_id;
end $$;

-- Delete a sale (to fix a mistake). Only whoever recorded it or received the money.
create or replace function delete_sale(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from sales where id = p_id
    and (recorded_by = my_partner() or paid_to = my_partner());
  if not found then raise exception 'You can only delete sales you recorded or were paid for'; end if;
end $$;

-- Stock on hand for every product: last fridge count + later deliveries - later sales.
create or replace function stock_levels() returns table (product_id text, qty int)
language sql stable security definer set search_path = public as $$
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

-- The signed-in partner's own money for a period (p_from = null means all time).
-- Returns only their numbers, plus the settle-up payments they are part of.
create or replace function my_money(p_from timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me text := my_partner();
  ids text[]; nets numeric[];
  i int; j int; amt numeric;
  pays jsonb := '[]'::jsonb;
  mine jsonb;
  sold jsonb;
begin
  if me is null then raise exception 'Not a BusyNes partner'; end if;

  -- everyone's balance = money received - value of their share of what sold
  select array_agg(x.id order by x.id), array_agg(x.net order by x.id) into ids, nets
  from (
    select p.id,
      coalesce((select sum(si.price * si.qty) from sales s join sale_items si on si.sale_id = s.id
                where s.paid_to = p.id and (p_from is null or s.at > p_from)), 0)
      - coalesce((select sum(si.price * si.qty * os.share) from sales s
                  join sale_items si on si.sale_id = s.id
                  join owner_shares os on os.owner = si.owner and os.partner_id = p.id
                  where (p_from is null or s.at > p_from)), 0) as net
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
    'received',      coalesce(sum(si.price * si.qty), 0),
    'received_cash', coalesce(sum(si.price * si.qty) filter (where s.method = 'cash'), 0),
    'orders',        count(distinct s.id))
  into mine
  from sales s join sale_items si on si.sale_id = s.id
  where s.paid_to = me and (p_from is null or s.at > p_from);

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

  return mine || jsonb_build_object(
    'me', me,
    'due', coalesce((select sum((e ->> 'my_share')::numeric) from jsonb_array_elements(sold) e), 0),
    'sold', sold,
    'pays', pays);
end $$;

-- Only signed-in users may call the functions.
revoke all on function record_sale(jsonb, text, text, text) from public, anon;
revoke all on function delete_sale(bigint) from public, anon;
revoke all on function stock_levels() from public, anon;
revoke all on function my_money(timestamptz) from public, anon;
grant execute on function record_sale(jsonb, text, text, text) to authenticated;
grant execute on function delete_sale(bigint) to authenticated;
grant execute on function stock_levels() to authenticated;
grant execute on function my_money(timestamptz) to authenticated;
revoke all on function my_partner() from public, anon;
revoke all on function sees_whole_sale(bigint) from public, anon;
revoke all on function sale_has_my_items(bigint) from public, anon;
grant execute on function my_partner() to authenticated;
grant execute on function sees_whole_sale(bigint) to authenticated;
grant execute on function sale_has_my_items(bigint) to authenticated;
