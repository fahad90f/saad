-- ============================================================
-- MT&B HOUSE — SAB PENDING DATABASE UPDATES EK SAATH
-- Supabase > SQL Editor mein yeh POORI file paste kar ke RUN karen.
-- Dobara chalana bilkul safe hai (sab kuch idempotent hai).
-- Included: daily closings, merchant payments column, expenses date
-- fix + backfill, pending-invoice auto-repair, transaction date
-- backfill, the Amanat (security deposit) table, ledger↔account
-- foreign keys (schema-cache relationship fix), product price repair,
-- invoice payment-method label sync, the product-images bucket,
-- business settings + duplicate-product merge, the stock ledger,
-- Customer/Merchant Amanat, monthly payroll, admin roles, product
-- clean-up (sold-out junk purge + history guard), live dashboard and
-- product delete (deleted products hidden, history kept) and the
-- merge of products whose names differ only in spaces/punctuation, and
-- sale-line costs (profit never counts a sale with no cost as all profit).
-- Sab se aakhir mein har product ka stock ledger ke mutabiq dobara
-- set ho jata hai, is liye yeh file kabhi bhi dobara chalayi ja sakti hai.
-- ============================================================

-- Daily closing reports: one row per closed day with the snapshot of that
-- day's numbers. Safe to re-run. Run in the Supabase SQL editor.

create table if not exists public.daily_closings (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  net_sales numeric not null default 0,
  cash_sales numeric not null default 0,
  credit_sales numeric not null default 0,
  recoveries numeric not null default 0,
  total_cash_in numeric not null default 0,
  expenses numeric not null default 0,
  net_cash numeric not null default 0,
  cash_in_hand numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists daily_closings_date_idx on public.daily_closings (closing_date);
-- Track merchant payments (cash out) in daily closings.
alter table public.daily_closings add column if not exists merchant_payments numeric not null default 0;
-- 1. Expenses: give date_of_expense a default and backfill old rows that
--    were saved without a date (they showed "—" and never appeared in the
--    daily closing).
alter table public.expenses alter column date_of_expense set default current_date;
update public.expenses
set date_of_expense = (created_at at time zone 'Asia/Karachi')::date
where date_of_expense is null;

-- 2. Repair invoice statuses: customers who already paid through their
--    account still had invoices stuck on unpaid/partial. Allocate each
--    client's surplus account payments to their outstanding invoices
--    (oldest first) and flip statuses to paid/partial automatically.
do $$
declare
  c record;
  inv record;
  surplus numeric;
  bal numeric;
  alloc numeric;
begin
  for c in select id from public.clients loop
    select coalesce((select sum(amount) from public.client_ledger
                     where client_id = c.id and entry_type = 'payment'), 0)
         - coalesce((select sum(ip.amount) from public.invoice_payments ip
                     join public.invoices i on i.id = ip.invoice_id
                     where i.client_id = c.id), 0)
      into surplus;

    for inv in
      select i.id, i.total_amount,
             i.total_amount - coalesce((select sum(amount) from public.invoice_payments
                                        where invoice_id = i.id), 0) as balance
      from public.invoices i
      where i.client_id = c.id and coalesce(i.payment_status, '') <> 'paid'
      order by i.created_at
    loop
      bal := inv.balance;
      if bal <= 0 then
        update public.invoices set payment_status = 'paid' where id = inv.id;
      elsif surplus > 0 then
        alloc := least(bal, surplus);
        insert into public.invoice_payments (invoice_id, amount, method, note)
        values (inv.id, alloc, 'cash', 'Auto-allocated from account payments (repair)');
        if alloc >= bal then
          update public.invoices set payment_status = 'paid' where id = inv.id;
        else
          update public.invoices set payment_status = 'partial' where id = inv.id;
        end if;
        surplus := surplus - alloc;
      end if;
    end loop;
  end loop;
end $$;
-- Every transaction must carry its date: set defaults and backfill all old
-- rows that were saved without one (they showed "—" in the history).
-- Backfill uses the row's creation time in Pakistan time.

alter table public.client_ledger   alter column entry_date set default current_date;
alter table public.merchant_ledger alter column entry_date set default current_date;
alter table public.stock_purchases alter column date set default current_date;

update public.client_ledger
set entry_date = (created_at at time zone 'Asia/Karachi')::date
where entry_date is null;

update public.merchant_ledger
set entry_date = (created_at at time zone 'Asia/Karachi')::date
where entry_date is null;

update public.stock_purchases
set date = (created_at at time zone 'Asia/Karachi')::date
where date is null;

update public.customer_purchases
set purchase_date = (created_at at time zone 'Asia/Karachi')::date
where purchase_date is null;

update public.invoice_payments
set payment_date = (created_at at time zone 'Asia/Karachi')::date
where payment_date is null;
-- Amanat (security deposit / temporary items given to a customer).
-- Any product can be given on amanat and returned later.

create sequence if not exists public.amanat_no_seq start 1001;

create table if not exists public.amanat_items (
  id uuid primary key default gen_random_uuid(),
  amanat_no text unique default ('AMT-' || nextval('public.amanat_no_seq')),
  customer_name text not null,
  phone text,
  client_id uuid references public.clients(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  item_name text not null,
  quantity integer not null default 1,
  given_date date not null default current_date,
  expected_return_date date,
  status text not null default 'out',          -- out / returned
  returned_date date,
  returned_quantity integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists amanat_items_status_idx on public.amanat_items (status);
create index if not exists amanat_items_client_idx on public.amanat_items (client_id);
-- Ledger ↔ account relationships + product price repair.
-- Fixes: "Could not find a relationship between 'client_ledger' and 'clients'
-- in the schema cache" (and the merchant_ledger/merchants twin), which also
-- silently blanked recoveries in Daily Closing and the Recoveries page.
-- Safe to re-run (idempotent).

-- 1. Detach orphaned ledger rows left behind by past account deletions
--    (no foreign key existed, so the rows survived pointing at nothing).
--    They are money that really moved, so they are kept — shown as
--    "Customer"/"Merchant" — and only the dead link is cleared. Clearing it
--    (rather than deleting the rows) keeps every daily closing and cash-flow
--    total intact, and each rupee still counted exactly once.
update public.client_ledger l
set client_id = null
where l.client_id is not null
  and not exists (select 1 from public.clients c where c.id = l.client_id);

update public.merchant_ledger l
set merchant_id = null
where l.merchant_id is not null
  and not exists (select 1 from public.merchants m where m.id = l.merchant_id);

-- 2. Real foreign keys so PostgREST can embed clients(name)/merchants(name)
--    in ledger queries. ON DELETE RESTRICT: an account with money history
--    can no longer be deleted outright (delete its ledger entries first) —
--    a cascade here would silently erase recorded payments from every
--    daily-closing and cash-flow report.
--    Guard on ANY existing foreign key between the two tables (not just our
--    constraint name): a second FK on the same pair would make PostgREST's
--    embed ambiguous instead of fixing it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.client_ledger'::regclass
      and confrelid = 'public.clients'::regclass
  ) then
    alter table public.client_ledger
      add constraint client_ledger_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.merchant_ledger'::regclass
      and confrelid = 'public.merchants'::regclass
  ) then
    alter table public.merchant_ledger
      add constraint merchant_ledger_merchant_id_fkey
      foreign key (merchant_id) references public.merchants(id) on delete restrict;
  end if;

  -- Purchase rows embed the product name the same way — make sure that
  -- relationship exists too (set null keeps the purchase history when a
  -- product is removed).
  if not exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.stock_purchases'::regclass
      and confrelid = 'public.products'::regclass
  ) then
    update public.stock_purchases sp set product_id = null
    where sp.product_id is not null
      and not exists (select 1 from public.products p where p.id = sp.product_id);
    alter table public.stock_purchases
      add constraint stock_purchases_product_id_fkey
      foreign key (product_id) references public.products(id) on delete set null;
  end if;
end $$;

create index if not exists client_ledger_client_id_idx on public.client_ledger (client_id);
create index if not exists client_ledger_entry_date_idx on public.client_ledger (entry_date);
create index if not exists merchant_ledger_merchant_id_idx on public.merchant_ledger (merchant_id);
create index if not exists merchant_ledger_entry_date_idx on public.merchant_ledger (entry_date);

-- 3. Product price repair: products booked in through stock purchases before
--    prices carried over automatically still ring up as Rs 0 in the POS.
--    Take each product's most recent stock-purchase cost as its purchase
--    price, then give products with no selling price that cost as well
--    (same rule new stock purchases apply).
update public.products p
set purchase_price = sp.purchase_price
from (
  select distinct on (product_id) product_id, purchase_price
  from public.stock_purchases
  where product_id is not null and coalesce(purchase_price, 0) > 0
  order by product_id, date desc nulls last, created_at desc
) sp
where sp.product_id = p.id
  and coalesce(p.purchase_price, 0) = 0;

-- (The old step that copied the cost into a blank selling price is gone: the
--  POS already falls back to cost for display, and copying it made every
--  later restock overwrite the shop price. The Products page owns prices.)

-- 4. PostgREST re-reads the schema so the new relationships work immediately.
notify pgrst, 'reload schema';
-- Invoice payment-method label kept in sync + product image bucket.
-- Safe to re-run (idempotent).

-- 1. invoices.payment_method is a text snapshot written at sale time
--    ("unpaid" for udhar bills) and was never updated when the bill was
--    paid later through a recovery — so the daily invoice list showed a
--    cash-paid bill as "unpaid". Recompute the label from the real
--    invoice_payments rows, and keep it in sync from now on with a trigger.
create or replace function public.payment_method_label(m text) returns text
language sql immutable as $$
  select case lower(coalesce(m, 'cash'))
    when 'cash' then 'Cash'
    when 'bank' then 'Bank transfer'
    when 'jazzcash' then 'JazzCash'
    when 'easypaisa' then 'Easypaisa'
    when 'card' then 'Card'
    when 'scrap' then 'Scrap'
    when 'other' then 'Other'
    else coalesce(m, 'Cash')
  end
$$;

create or replace function public.invoice_methods_summary(inv_id uuid) returns text
language sql stable as $$
  -- Methods in the order they were first used, e.g. "Cash + Bank transfer".
  -- Fixed canonical order, the same as PAYMENT_METHODS in the app (a split
  -- sale inserts all its rows in one statement, so "first used" is a tie
  -- and only a fixed rank can agree with the receipt): e.g. "Cash + Scrap".
  select string_agg(label, ' + ' order by rank, label)
  from (
    select public.payment_method_label(method) as label,
           min(coalesce(array_position(array['cash','jazzcash','easypaisa','bank','card','scrap','other'], lower(method)), 99)) as rank
    from public.invoice_payments
    where invoice_id = inv_id and amount > 0
    group by 1
  ) m
$$;

create or replace function public.sync_invoice_payment_method() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  iid uuid;
  label text;
begin
  iid := coalesce(new.invoice_id, old.invoice_id);
  label := public.invoice_methods_summary(iid);
  if label is not null then
    update public.invoices set payment_method = label where id = iid;
  end if;
  return coalesce(new, old);
end $$;

-- CREATE OR REPLACE (Postgres 14+) rather than drop-and-create: tooling
-- that gates "destructive" statements stalls on DROP, and this is idempotent.
create or replace trigger invoice_payments_sync_method
after insert or update or delete on public.invoice_payments
for each row execute function public.sync_invoice_payment_method();

-- One-time repair of every bill whose stored label no longer matches how
-- it was actually paid. Cancelled bills are left alone.
update public.invoices i
set payment_method = public.invoice_methods_summary(i.id)
where coalesce(i.payment_status, '') <> 'cancelled'
  and public.invoice_methods_summary(i.id) is not null
  and coalesce(i.payment_method, '') is distinct from public.invoice_methods_summary(i.id);

-- 2. Product image uploads failed because the bucket the app uploads to
--    never existed (its access policies did). Public read, 5 MB, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/*'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Business settings (owner-editable company details) + product clean-up.
-- Safe to re-run (idempotent).

-- 1. Company details shown on slips, letterheads and the contact page, edited
--    in Admin → Business Settings. Blank bank fields stay off the slip.
create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('name', 'MT&B House Auto Hub'),
  ('full_name', 'Muzaffar Tyres & Batteries House Auto Hub'),
  ('tagline', 'Tyres · Batteries · Engine Oil · Rims · Car Accessories'),
  ('phone', '0304-0510256'),
  ('email', 'muzaffartyresandbatteries@gmail.com'),
  ('website', 'mtbhouse.store'),
  ('address', 'Near Degree Boys College, Multan Road, Muzaffargarh'),
  ('branch', 'Muzaffargarh'),
  ('jazzcash_number', '03017881150'),
  ('jazzcash_title', 'Muzaffar Iqbal'),
  ('bank_name', 'Bank Alfalah'),
  ('bank_account_title', 'Muzaffar Tyre and Battery House'),
  ('bank_account_number', '01661003362641'),
  ('bank_iban', '')
on conflict (key) do nothing;

-- 2. Merge duplicate products (same name ignoring case/spacing). The copy
--    with the most stock (then most history, price, newest) survives; the
--    other copies' stock is added to it, whatever the keeper lacks (cost,
--    image, description, category, brand, featured/deal flags) is taken from
--    the copies, every sale/purchase/quotation/amanat row is re-pointed to
--    it, and the copies are removed. A copy that is the same entry saved
--    twice (never booked in, identical row created moments later) is not
--    counted as extra stock. The merged product stays deleted (Products →
--    Delete, 20261111) only when every copy was deleted.
alter table public.products add column if not exists deleted_at timestamptz;
do $$
declare
  grp record;
  keeper uuid;
  rest record;
  twins uuid[];
  trg record;
begin
  -- The stock-ledger triggers (20261015) would move stock along with the
  -- re-pointed ledger rows and double-count it; the keeper's stock is set
  -- explicitly below, so pause them for the merge.
  for trg in
    select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname like 'stock\_ledger\_%' and not t.tgisinternal
  loop
    execute format('alter table public.%I disable trigger %I', trg.relname, trg.tgname);
  end loop;

  for grp in
    select lower(regexp_replace(trim(product_name), '\s+', ' ', 'g')) as norm, array_agg(id) as ids
    from public.products
    group by 1 having count(*) > 1
  loop
    select p.id into keeper
    from public.products p
    where p.id = any(grp.ids)
    order by coalesce(p.quantity_in_stock, 0) desc,
             ((select count(*) from public.invoice_items ii where ii.product_id = p.id)
              + (select count(*) from public.customer_purchases cp where cp.product_id = p.id)
              + (select count(*) from public.stock_purchases sp where sp.product_id = p.id)) desc,
             coalesce(p.selling_price, 0) desc, p.created_at desc
    limit 1;

    -- the same entry saved twice: never booked in, and an identical row
    -- (stock and prices) was created within a minute after it — its stock
    -- is the same units counted twice, so it is not added
    select coalesce(array_agg(c.id), '{}') into twins
    from public.products c
    where c.id = any(grp.ids) and c.id <> keeper
      and not exists (select 1 from public.stock_purchases sp where sp.product_id = c.id)
      and exists (select 1 from public.products o
                  where o.id = any(grp.ids) and o.id <> c.id
                    and coalesce(o.quantity_in_stock, 0) = coalesce(c.quantity_in_stock, 0)
                    and coalesce(o.selling_price, 0) = coalesce(c.selling_price, 0)
                    and coalesce(o.purchase_price, 0) = coalesce(c.purchase_price, 0)
                    and o.created_at >= c.created_at and o.created_at < c.created_at + interval '1 minute'
                    and (o.created_at > c.created_at or o.id > c.id));

    select coalesce(sum(case when c.id = any(twins) then 0 else coalesce(c.quantity_in_stock, 0) end), 0) as extra_stock,
           coalesce(max(coalesce(c.selling_price, 0)), 0)  as best_price,
           coalesce(max(coalesce(c.purchase_price, 0)), 0) as best_cost,
           max(nullif(c.image_url, ''))      as image_url,
           max(nullif(c.description, ''))    as description,
           max(c.category_id::text)::uuid    as category_id,
           max(c.subcategory_id::text)::uuid as subcategory_id,
           max(c.brand_id::text)::uuid       as brand_id,
           bool_or(c.is_featured)            as is_featured,
           bool_or(c.is_deal)                as is_deal,
           max(c.deal_end_date)              as deal_end_date,
           bool_and(c.deleted_at is not null) as all_deleted
      into rest
    from public.products c
    where c.id = any(grp.ids) and c.id <> keeper;

    update public.invoice_items      set product_id = keeper where product_id = any(grp.ids) and product_id <> keeper;
    update public.customer_purchases set product_id = keeper where product_id = any(grp.ids) and product_id <> keeper;
    update public.stock_purchases    set product_id = keeper where product_id = any(grp.ids) and product_id <> keeper;
    update public.quotation_items    set product_id = keeper where product_id = any(grp.ids) and product_id <> keeper;
    update public.amanat_items       set product_id = keeper where product_id = any(grp.ids) and product_id <> keeper;
    if to_regclass('public.stock_adjustments') is not null then
      -- counts recorded on the other copies follow their units to the keeper;
      -- a twin's count is dropped with the twin (its units were counted once)
      update public.stock_adjustments set product_id = keeper
      where product_id = any(grp.ids) and product_id <> keeper and not (product_id = any(twins));
    end if;

    update public.products
    set quantity_in_stock = coalesce(quantity_in_stock, 0) + rest.extra_stock,
        selling_price  = case when coalesce(selling_price, 0)  > 0 then selling_price  else rest.best_price end,
        purchase_price = case when coalesce(purchase_price, 0) > 0 then purchase_price else rest.best_cost end,
        image_url      = coalesce(nullif(image_url, ''),   rest.image_url),
        description    = coalesce(nullif(description, ''), rest.description),
        category_id    = coalesce(category_id,    rest.category_id),
        subcategory_id = coalesce(subcategory_id, rest.subcategory_id),
        brand_id       = coalesce(brand_id,       rest.brand_id),
        is_featured    = coalesce(is_featured, false) or coalesce(rest.is_featured, false),
        is_deal        = coalesce(is_deal, false)     or coalesce(rest.is_deal, false),
        deal_end_date  = greatest(deal_end_date, rest.deal_end_date),
        deleted_at     = case when rest.all_deleted then deleted_at end
    where id = keeper;

    delete from public.products where id = any(grp.ids) and id <> keeper;
  end loop;

  for trg in
    select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname like 'stock\_ledger\_%' and not t.tgisinternal
  loop
    execute format('alter table public.%I enable trigger %I', trg.relname, trg.tgname);
  end loop;
end $$;

-- 3. Remove the junk left by mistyped "add new product" entries: a bare name
--    with no stock, prices, image, description, category or website flags,
--    never bought, sold, quoted or given on amanat. A product entered on the
--    Products page ahead of its stock is none of those, so it stays.
delete from public.products p
where coalesce(p.quantity_in_stock, 0) <= 0
  and coalesce(p.selling_price, 0) = 0 and coalesce(p.purchase_price, 0) = 0
  and coalesce(p.image_url, '') = '' and coalesce(p.description, '') = ''
  and p.category_id is null and p.brand_id is null
  and not coalesce(p.is_featured, false) and not coalesce(p.is_deal, false)
  and not exists (select 1 from public.invoice_items      x where x.product_id = p.id)
  and not exists (select 1 from public.customer_purchases x where x.product_id = p.id)
  and not exists (select 1 from public.stock_purchases    x where x.product_id = p.id)
  and not exists (select 1 from public.quotation_items    x where x.product_id = p.id)
  and not exists (select 1 from public.amanat_items       x where x.product_id = p.id);

-- 4. Lock the settings down. Anyone may read them (contact page, slips) but
--    only a signed-in admin may change them — otherwise whoever holds the
--    public API key could put their own bank account on every slip. The
--    role table gets the same treatment, or anyone could make themselves an
--    admin first. (Policies are created only if missing, so re-runs are safe.)
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role);
$$;
revoke execute on function public.has_role(uuid, public.app_role) from anon, public;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;

alter table public.app_settings enable row level security;
alter table public.user_roles  enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings' and policyname = 'settings read') then
    create policy "settings read" on public.app_settings for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings' and policyname = 'settings admin write') then
    create policy "settings admin write" on public.app_settings for all to authenticated
      using (public.has_role((select auth.uid()), 'admin'))
      with check (public.has_role((select auth.uid()), 'admin'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'roles own read') then
    create policy "roles own read" on public.user_roles for select to authenticated using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'roles admin read') then
    create policy "roles admin read" on public.user_roles for select to authenticated using (public.has_role((select auth.uid()), 'admin'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'roles self customer') then
    -- sign-up gives the new account the plain customer role, nothing more
    create policy "roles self customer" on public.user_roles for insert to authenticated
      with check ((select auth.uid()) = user_id and role = 'customer');
  end if;
end $$;

-- Relationships the admin pages embed but the database never had, which made
-- PostgREST fail with "Could not find a relationship between ... in the schema
-- cache" — so the Products page, stock-out movements and sales history loaded
-- empty. Safe to re-run (idempotent). Dead links are cleared, never deleted.

update public.products p set category_id = null where p.category_id is not null and not exists (select 1 from public.categories c where c.id = p.category_id);
update public.products p set brand_id = null where p.brand_id is not null and not exists (select 1 from public.brands b where b.id = p.brand_id);
update public.templates t set category_id = null where t.category_id is not null and not exists (select 1 from public.categories c where c.id = t.category_id);
update public.customer_purchases cp set product_id = null where cp.product_id is not null and not exists (select 1 from public.products p where p.id = cp.product_id);
update public.invoice_items ii set invoice_id = null where ii.invoice_id is not null and not exists (select 1 from public.invoices i where i.id = ii.invoice_id);

do $$
begin
  if not exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'public.products'::regclass and confrelid = 'public.categories'::regclass) then
    alter table public.products add constraint products_category_id_fkey foreign key (category_id) references public.categories(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'public.products'::regclass and confrelid = 'public.brands'::regclass) then
    alter table public.products add constraint products_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'public.templates'::regclass and confrelid = 'public.categories'::regclass) then
    alter table public.templates add constraint templates_category_id_fkey foreign key (category_id) references public.categories(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'public.customer_purchases'::regclass and confrelid = 'public.products'::regclass) then
    alter table public.customer_purchases add constraint customer_purchases_product_id_fkey foreign key (product_id) references public.products(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'public.invoice_items'::regclass and confrelid = 'public.invoices'::regclass) then
    alter table public.invoice_items add constraint invoice_items_invoice_id_fkey foreign key (invoice_id) references public.invoices(id) on delete cascade;
  end if;
end $$;

create index if not exists invoice_items_invoice_id_idx on public.invoice_items (invoice_id);
create index if not exists customer_purchases_product_id_idx on public.customer_purchases (product_id);

notify pgrst, 'reload schema';

-- Stock is owned by the database from here on.
--
-- products.quantity_in_stock used to be a counter that six screens rewrote
-- from numbers loaded when the page opened: sales from another phone were
-- overwritten, an oversold quantity was clamped away, returns re-added units
-- that had never come off, and a purchase could be saved without its stock
-- arriving. Now the ledgers are the truth — stock_purchases (in),
-- invoice_items (out) and stock_adjustments (counts and corrections) — and
-- triggers keep the counter in step atomically, from any device. Deleting or
-- shrinking a sale line gives the units back by itself; a purchase row adds
-- them by itself. The counter may go below zero (sold before the purchase
-- was booked); the app shows anything at or below zero as "Out of stock".
--
-- Nothing else may write the counter: a guard trigger ignores direct writes
-- (the old app's read-modify-write, a stale browser tab, a hand edit in the
-- table editor), so this file can run before or after the app update without
-- double counting. Run it BEFORE deploying the app version that uses it (that
-- version reads products.track_stock). Safe to re-run: every run ends by
-- resyncing each product to its ledger.

-- 1. Counts and corrections (opening stock, physical counts, damaged units,
--    returns to the merchant) as ledger rows instead of overwrites.
create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  delta integer not null,
  reason text not null default 'Correction',
  note text,
  created_at timestamptz not null default now()
);
create index if not exists stock_adjustments_product_id_idx on public.stock_adjustments (product_id);
create index if not exists stock_adjustments_created_at_idx on public.stock_adjustments (created_at);

-- Services, trade-ins and consumables that are sold without ever being
-- booked in (battery charging, wheel balancing, old tyres taken in) are not
-- stock-tracked: always sellable, never "out of stock". The owner can switch
-- it per product on the Products page.
alter table public.products add column if not exists track_stock boolean not null default true;

alter table public.products alter column quantity_in_stock set default 0;
update public.products set quantity_in_stock = 0 where quantity_in_stock is null;
alter table public.products alter column quantity_in_stock set not null;

-- Sale lines point at products like every other ledger (a deleted product
-- leaves the line, with no product, instead of a dangling id).
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid join pg_class r on r.oid = c.confrelid
    where c.contype = 'f' and t.relname = 'invoice_items' and r.relname = 'products'
  ) then
    update public.invoice_items i set product_id = null
    where i.product_id is not null and not exists (select 1 from public.products p where p.id = i.product_id);
    alter table public.invoice_items
      add constraint invoice_items_product_id_fkey foreign key (product_id) references public.products(id) on delete set null;
  end if;
end $$;
create index if not exists invoice_items_product_id_idx on public.invoice_items (product_id);
create index if not exists stock_purchases_product_id_idx on public.stock_purchases (product_id);

-- 2. The ledger view of a product's stock, and the sync that keeps the
--    counter equal to it.
create or replace function public.stock_derived(_product uuid)
returns integer language sql stable set search_path = public as $$
  select coalesce((select sum(quantity) from public.stock_purchases   where product_id = _product), 0)::integer
       - coalesce((select sum(quantity) from public.invoice_items     where product_id = _product), 0)::integer
       + coalesce((select sum(delta)    from public.stock_adjustments where product_id = _product), 0)::integer;
$$;

-- The one door to the counter. It raises the app.stock_sync flag for the
-- duration of its update so the guard below lets the write through.
create or replace function public.stock_apply(_product uuid, _delta integer)
returns void language plpgsql set search_path = public as $$
declare prev text := current_setting('app.stock_sync', true);
begin
  if _product is null or coalesce(_delta, 0) = 0 then return; end if;
  perform set_config('app.stock_sync', 'on', true);
  update public.products set quantity_in_stock = coalesce(quantity_in_stock, 0) + _delta where id = _product;
  perform set_config('app.stock_sync', coalesce(prev, ''), true);
end $$;
-- only the ledger triggers (owned by the database) may call it
revoke execute on function public.stock_apply(uuid, integer) from public, anon, authenticated;

-- Set every listed product (all when null) to its ledger figure.
create or replace function public.stock_resync(_products uuid[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare prev text := current_setting('app.stock_sync', true); n integer;
begin
  perform set_config('app.stock_sync', 'on', true);
  update public.products p set quantity_in_stock = public.stock_derived(p.id)
  where (_products is null or p.id = any(_products))
    and p.quantity_in_stock <> public.stock_derived(p.id);
  get diagnostics n = row_count;
  perform set_config('app.stock_sync', coalesce(prev, ''), true);
  return n;
end $$;
revoke execute on function public.stock_resync(uuid[]) from public, anon;

-- One trigger function for all three ledgers: purchases and adjustments add,
-- sale lines subtract; an update moves the difference (and moves the units
-- when the row is re-pointed at another product).
create or replace function public.stock_ledger_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  qcol text := case tg_table_name when 'stock_adjustments' then 'delta' else 'quantity' end;
  sign integer := case tg_table_name when 'invoice_items' then -1 else 1 end;
  old_pid uuid; new_pid uuid; old_q integer := 0; new_q integer := 0;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_pid := (to_jsonb(old) ->> 'product_id')::uuid;
    old_q := coalesce((to_jsonb(old) ->> qcol)::integer, 0);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_pid := (to_jsonb(new) ->> 'product_id')::uuid;
    new_q := coalesce((to_jsonb(new) ->> qcol)::integer, 0);
  end if;
  if old_pid is not null and old_pid is not distinct from new_pid then
    perform public.stock_apply(old_pid, sign * (new_q - old_q));
  else
    if old_pid is not null then perform public.stock_apply(old_pid, -sign * old_q); end if;
    if new_pid is not null then perform public.stock_apply(new_pid,  sign * new_q); end if;
  end if;
  return null;
end $$;

create or replace trigger stock_ledger_purchases
  after insert or update or delete on public.stock_purchases
  for each row execute function public.stock_ledger_sync();
create or replace trigger stock_ledger_sales
  after insert or update or delete on public.invoice_items
  for each row execute function public.stock_ledger_sync();
create or replace trigger stock_ledger_adjustments
  after insert or update or delete on public.stock_adjustments
  for each row execute function public.stock_ledger_sync();

-- Guard: a direct write of the counter (anything but stock_apply/stock_resync)
-- is ignored — the value stays what the ledger made it.
create or replace function public.stock_ledger_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_setting('app.stock_sync', true) is distinct from 'on' then
    new.quantity_in_stock := old.quantity_in_stock;
  end if;
  return new;
end $$;
create or replace trigger stock_ledger_guard
  before update of quantity_in_stock on public.products
  for each row execute function public.stock_ledger_guard();

-- A product created with a starting count (the old Products page, a CSV
-- import) gets that count recorded as an "Opening count" ledger row.
create or replace function public.stock_ledger_opening()
returns trigger language plpgsql security definer set search_path = public as $$
declare prev text := current_setting('app.stock_sync', true);
begin
  if coalesce(new.quantity_in_stock, 0) <> 0 and prev is distinct from 'on' then
    perform set_config('app.stock_sync', 'on', true);
    update public.products set quantity_in_stock = 0 where id = new.id;
    perform set_config('app.stock_sync', coalesce(prev, ''), true);
    insert into public.stock_adjustments (product_id, delta, reason, note)
    values (new.id, new.quantity_in_stock, 'Opening count', 'Stock entered with the new product');
  end if;
  return null;
end $$;
create or replace trigger stock_ledger_opening
  after insert on public.products
  for each row execute function public.stock_ledger_opening();

-- A physical count, booked as the difference to the live ledger figure in a
-- single statement (no stale number from a page opened earlier). Returns the
-- difference recorded (0 records nothing).
create or replace function public.stock_set_count(_product uuid, _counted integer, _reason text default 'Physical count', _note text default null)
returns integer language plpgsql set search_path = public as $$
declare d integer;
begin
  if _counted is null or _counted < 0 then raise exception 'Counted stock must be zero or more'; end if;
  perform 1 from public.products where id = _product for update;
  if not found then raise exception 'Product not found'; end if;
  d := _counted - public.stock_derived(_product);
  if d <> 0 then
    insert into public.stock_adjustments (product_id, delta, reason, note)
    values (_product, d, coalesce(nullif(trim(_reason), ''), 'Physical count'), nullif(trim(coalesce(_note, '')), ''));
  end if;
  return d;
end $$;
revoke execute on function public.stock_set_count(uuid, integer, text, text) from public, anon;
grant execute on function public.stock_set_count(uuid, integer, text, text) to authenticated;

-- Products whose counter disagrees with the ledger (should stay empty).
create or replace view public.stock_reconciliation as
  select p.id, p.product_name, p.quantity_in_stock as stored, public.stock_derived(p.id) as derived
  from public.products p
  where p.quantity_in_stock <> public.stock_derived(p.id);

-- 3. One-time reconciliation (marked in app_settings so re-runs skip it).
--    The old register's opening counts did not always match the purchases
--    imported with them (one product had stock with no purchase rows, seven
--    had sold units before the system existed); those gaps are recorded as
--    "Opening stock" rows so the ledger explains the count. A product given
--    a starting count on the Products page and never booked in keeps it the
--    same way. Then every product takes the ledger figure —
--    including below zero where units were sold that were never booked in,
--    which the app now shows as out of stock until the purchase is entered.
do $$
begin
  if exists (select 1 from public.app_settings where key = 'stock_ledger_backfill') then return; end if;

  -- sold, never booked in, nothing on the shelf: a service or trade-in item
  update public.products p set track_stock = false
  where p.quantity_in_stock <= 0
    and exists (select 1 from public.invoice_items x where x.product_id = p.id)
    and not exists (select 1 from public.stock_purchases x where x.product_id = p.id)
    and not exists (select 1 from public.stock_adjustments x where x.product_id = p.id);

  insert into public.stock_adjustments (product_id, delta, reason, note)
  -- (opening count − purchases imported − legacy sales imported, per the
  --  2026-07-16 import file; a positive gap is stock with no purchase row, a
  --  negative one units sold before the system existed)
  select v.id::uuid, v.delta, 'Opening stock', 'Old register count minus the purchases and sales imported with it (2026-07-15 import)'
  from (values
    ('b3198079-a292-4c3c-8514-005c61d6000b', 35),  -- Sunfull
    ('3952bec9-9db2-4646-899e-67dda5aabb7b', -1),  -- 185R14
    ('d06c8f5d-23af-4491-be2c-b3382cafb659', -2),  -- Evergreen 145R12
    ('5802e98a-e32f-4828-aa21-d0d444bdd2ca', -2),  -- Ovation 195/65R15
    ('9302b467-c9cc-4b15-ba23-5f0bcc9da30b', -1),  -- HT200 osaka 21p
    ('f30133de-bdeb-4617-a331-77943d8483f9', -1),  -- HT160 osaka 19p
    ('e0a74211-bf17-44df-9119-e0de840f7c53', -2),  -- Michelin 215/75R14
    ('16503174-2cfb-4f64-a860-6fd47b50d48b', -1)   -- 500-12 Tube Diamond
  ) as v(id, delta)
  where exists (select 1 from public.products p where p.id = v.id::uuid)
    and not exists (select 1 from public.stock_adjustments a where a.product_id = v.id::uuid and a.reason = 'Opening stock');

  -- A count typed on the Products page (never booked as a purchase) is the
  -- counter plus whatever has been sold from it since: record that gap.
  insert into public.stock_adjustments (product_id, delta, reason, note)
  select p.id, p.quantity_in_stock - public.stock_derived(p.id), 'Opening count',
         'Starting stock entered on the Products page (count shown plus units sold since)'
  from public.products p
  where p.quantity_in_stock > 0
    and p.quantity_in_stock <> public.stock_derived(p.id)
    and not exists (select 1 from public.stock_purchases   x where x.product_id = p.id)
    and not exists (select 1 from public.stock_adjustments x where x.product_id = p.id);

  insert into public.app_settings (key, value) values ('stock_ledger_backfill', now()::text)
  on conflict (key) do nothing;
end $$;

-- Every run: make each product equal to its ledger. On the first run this
-- is the reconciliation; afterwards it is a no-op unless something drifted
-- (it heals the stock if anything ever wrote the counter around the ledger).
select public.stock_resync();

-- 4. One product per name (the merge above folds the old copies together
--    first; until that has run the index is skipped, and the app itself
--    reuses an existing name instead of inserting a copy).
do $$
begin
  if exists (
    select 1 from public.products
    group by lower(regexp_replace(trim(product_name), '\s+', ' ', 'g')) having count(*) > 1
  ) then
    raise notice 'duplicate product names remain — unique name index skipped; run the duplicate merge first';
  else
    create unique index if not exists products_name_norm_uidx
      on public.products ((lower(regexp_replace(trim(product_name), '\s+', ' ', 'g'))));
  end if;
end $$;

notify pgrst, 'reload schema';

-- Amanat for both sides: Customer Amanat and Merchant Amanat.
--
-- Amanat is anything held in trust between the shop and a party, either way
-- round, seen from the shop:
--   direction 'taken' — the party took our item / money (it is with them)
--   direction 'left'  — the party left their item / money with us (we hold it)
--   status 'pending'  — still open
--   status 'received' — settled (received back / handed back)
-- An entry belongs to a customer (client_id) or a merchant (merchant_id) and
-- is either goods (kind 'item', quantity) or cash (kind 'money', amount).
--
-- Amanat never touches client_ledger / merchant_ledger: money held in trust
-- is not part of the account balance (the app shows it beside the balance).
--
-- An item taken from shelf stock (from_stock) is booked in stock_adjustments
-- ('Amanat' reason, linked by amanat_id) and the stock ledger triggers move
-- products.quantity_in_stock from it. The rows are append-only, so every
-- movement keeps its own date on the dashboard and the Inventory page:
-- giving the item out adds a minus row, a partial return or "received" adds
-- a plus row for the units back, reopening adds a minus row again, and a
-- product change books the units back on the old product and out on the new
-- one. Deleting the amanat deletes all its rows (cascade, net zero) and so
-- gives the units back. Items a party LEFT with us are not ours and never add
-- to stock. Existing rows keep from_stock = false, so nothing changes
-- retroactively.
--
-- Needs 20261015000000_stock_ledger.sql. Safe to re-run (no drops).

-- 1. Columns.
alter table public.amanat_items add column if not exists party_type text not null default 'client';
alter table public.amanat_items add column if not exists merchant_id uuid references public.merchants(id) on delete set null;
alter table public.amanat_items add column if not exists direction text not null default 'taken';
alter table public.amanat_items add column if not exists kind text not null default 'item';
alter table public.amanat_items add column if not exists amount numeric;
alter table public.amanat_items add column if not exists contact text;
alter table public.amanat_items add column if not exists from_stock boolean not null default false;

-- 2. Status words: out -> pending, returned -> received.
update public.amanat_items
   set status = case when status in ('returned', 'received') then 'received' else 'pending' end
 where status is distinct from 'pending' and status is distinct from 'received';
alter table public.amanat_items alter column status set default 'pending';

-- Old rows may carry quantities the checks below reject; bring them in range
-- (a received row has everything back).
update public.amanat_items set quantity = 1 where quantity is null or quantity < 1;
update public.amanat_items
   set returned_quantity = case when status = 'received' then quantity
                                else least(greatest(coalesce(returned_quantity, 0), 0), quantity) end
 where returned_quantity is null or returned_quantity < 0 or returned_quantity > quantity;

-- 3. Rules.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_party_type_chk') then
    alter table public.amanat_items add constraint amanat_items_party_type_chk
      check (party_type in ('client', 'merchant'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_direction_chk') then
    alter table public.amanat_items add constraint amanat_items_direction_chk
      check (direction in ('taken', 'left'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_status_chk') then
    alter table public.amanat_items add constraint amanat_items_status_chk
      check (status in ('pending', 'received'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_kind_chk') then
    alter table public.amanat_items add constraint amanat_items_kind_chk
      check (kind in ('item', 'money'));
  end if;
  -- a customer entry never points at a merchant and vice versa
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_party_chk') then
    alter table public.amanat_items add constraint amanat_items_party_chk
      check ((party_type = 'client' and merchant_id is null) or (party_type = 'merchant' and client_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_money_amount_chk') then
    alter table public.amanat_items add constraint amanat_items_money_amount_chk
      check (kind <> 'money' or coalesce(amount, 0) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_quantity_chk') then
    alter table public.amanat_items add constraint amanat_items_quantity_chk
      check (quantity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'amanat_items_returned_qty_chk') then
    alter table public.amanat_items add constraint amanat_items_returned_qty_chk
      check (returned_quantity between 0 and quantity);
  end if;
end $$;

create index if not exists amanat_items_merchant_idx on public.amanat_items (merchant_id);

-- 4. Shelf stock for items taken out of stock.
alter table public.stock_adjustments add column if not exists amanat_id uuid references public.amanat_items(id) on delete cascade;
create index if not exists stock_adjustments_amanat_id_idx
  on public.stock_adjustments (amanat_id) where amanat_id is not null;

-- Keeps the sum of the amanat's adjustment rows equal to the units still
-- out: -(quantity - returned), 0 once received or when not from stock. Rows
-- are never changed or removed here; each change appends the difference to
-- what is already booked, dated now.
create or replace function public.amanat_stock_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  want integer := 0;
  booked integer;
  diff integer;
  tracked boolean;
  label text := coalesce(new.amanat_no, 'Amanat') || ' — ' || new.customer_name;
  r record;
begin
  if new.from_stock and new.kind = 'item' and new.direction = 'taken' and new.product_id is not null then
    select p.track_stock into tracked from public.products p where p.id = new.product_id;
    if coalesce(tracked, false) then
      want := -(new.quantity - case when new.status = 'received' then new.quantity
                                    else least(greatest(coalesce(new.returned_quantity, 0), 0), new.quantity) end);
    end if;
  end if;

  -- Units still booked against another product (the product was changed or
  -- cleared) go back to that product. A product being deleted is skipped:
  -- its rows go with it.
  for r in
    select a.product_id, sum(a.delta)::integer as booked
      from public.stock_adjustments a
      join public.products p on p.id = a.product_id
     where a.amanat_id = new.id and a.product_id is distinct from new.product_id
     group by a.product_id
    having sum(a.delta) <> 0
  loop
    insert into public.stock_adjustments (product_id, delta, reason, note, amanat_id)
    values (r.product_id, -r.booked, 'Amanat',
            label || case when -r.booked > 0 then ' (returned)' else ' (given out)' end, new.id);
  end loop;

  -- The current product: book the difference between what should be out and
  -- what is booked (from_stock turned off or "received" gives it all back).
  if new.product_id is not null then
    select coalesce(sum(a.delta), 0)::integer into booked
      from public.stock_adjustments a
     where a.amanat_id = new.id and a.product_id = new.product_id;
    diff := want - booked;
    if diff <> 0 then
      insert into public.stock_adjustments (product_id, delta, reason, note, amanat_id)
      values (new.product_id, diff, 'Amanat',
              label || case when diff > 0 then ' (returned)' else ' (given out)' end, new.id);
    end if;
  end if;
  return null;
end $$;

create or replace trigger amanat_stock_sync
  after insert or update on public.amanat_items
  for each row execute function public.amanat_stock_sync();

notify pgrst, 'reload schema';

-- Payroll: which month's salary each employee has been paid.
--
-- The Employees page only knew each person's fixed salary; whether a month
-- had actually been paid lived in the owner's head (and in hand-typed
-- Expenses such as "zain 25000" or "Zain ko dea 5000"). Now every salary
-- payment is a row here, for one employee and one month (YYYY-MM). A month
-- may hold several rows (advances, part payments); its status is derived:
-- Paid when the payments add up to the salary due, Partial below that,
-- Unpaid when there are none.
--
-- Every payment is ALSO an expense, exactly once, because Expenses drive the
-- Daily Closing net cash, Reports and the Dashboard profit:
--   * paid from the Employees page -> salary_mark_paid() creates the expense
--     ("Salary — Zain") and links it (expense_created = true);
--   * already typed in Expenses by hand -> the owner links that expense
--     instead (expense_created = false), so it is never counted twice.
-- Deleting the expense on the Expenses page deletes its payment with it (the
-- month goes back to Unpaid/Partial). Marking a month unpaid removes the
-- expenses payroll created and leaves hand-typed ones (that cash really went
-- out). Deleting an employee deletes their payroll history; the expenses stay.
--
-- Safe to re-run: nothing is dropped, policies are created only if missing.

-- 1. The payments.
create table if not exists public.salary_payments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric not null check (amount > 0),
  -- employees.salary when the payment was recorded (a later raise does not
  -- rewrite what was due in an old month)
  salary_due numeric not null default 0,
  paid_date date not null default current_date,
  method text not null default 'cash',
  expense_id uuid unique references public.expenses(id) on delete cascade,
  -- false = linked to an expense the owner typed by hand
  expense_created boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists salary_payments_month_idx on public.salary_payments (month);
create index if not exists salary_payments_employee_month_idx on public.salary_payments (employee_id, month);

-- 2. Admin only (salaries are nobody else's business).
alter table public.salary_payments enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_payments' and policyname = 'salary payments admin') then
    create policy "salary payments admin" on public.salary_payments for all to authenticated
      using (public.has_role((select auth.uid()), 'admin'))
      with check (public.has_role((select auth.uid()), 'admin'));
  end if;
end $$;

-- 3. Record a payment for an employee's month, with its expense, in one
--    transaction. With _expense: link that (hand-typed) expense — its amount
--    and date are the payment's. Without: _amount is paid on _paid_date and
--    a "Salary — <name>" expense is created for it. Returns the payment id.
create or replace function public.salary_mark_paid(
  _employee uuid,
  _month text,
  _amount numeric default null,
  _paid_date date default current_date,
  _method text default 'cash',
  _expense uuid default null,
  _notes text default null
)
returns uuid language plpgsql set search_path = public as $$
declare
  emp_name text;
  emp_salary numeric;
  exp_amount numeric;
  exp_date date;
  m text := lower(coalesce(nullif(trim(_method), ''), 'cash'));
  note text := nullif(trim(coalesce(_notes, '')), '');
  month_label text;
  method_label text;
  amt numeric;
  d date;
  eid uuid;
  pid uuid;
begin
  if _month is null or _month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Month must look like YYYY-MM (got %)', coalesce(_month, 'nothing');
  end if;
  select e.name, e.salary into emp_name, emp_salary from public.employees e where e.id = _employee;
  if not found then raise exception 'Employee not found'; end if;
  month_label := to_char(to_date(_month || '-01', 'YYYY-MM-DD'), 'Mon YYYY');

  if _expense is not null then
    select x.amount, x.date_of_expense into exp_amount, exp_date from public.expenses x where x.id = _expense;
    if not found then raise exception 'That expense no longer exists'; end if;
    if exists (select 1 from public.salary_payments s where s.expense_id = _expense) then
      raise exception 'That expense is already linked to a salary payment';
    end if;
    if coalesce(exp_amount, 0) <= 0 then raise exception 'That expense has no amount'; end if;
    amt := exp_amount;
    d := coalesce(exp_date, current_date);
    eid := _expense;
  else
    if _amount is null or _amount <= 0 then raise exception 'Amount must be more than zero'; end if;
    amt := _amount;
    d := coalesce(_paid_date, current_date);
    method_label := case m
      when 'cash' then 'Cash' when 'jazzcash' then 'JazzCash' when 'easypaisa' then 'Easypaisa'
      when 'bank' then 'Bank transfer' when 'card' then 'Card' when 'other' then 'Other'
      else m end;
    insert into public.expenses (expense_type, amount, notes, date_of_expense)
    values ('Salary — ' || coalesce(nullif(trim(emp_name), ''), 'employee'), amt,
            'Salary for ' || month_label || ' · ' || method_label || coalesce(' · ' || note, ''), d)
    returning id into eid;
  end if;

  begin
    insert into public.salary_payments (employee_id, month, amount, salary_due, paid_date, method, expense_id, expense_created, notes)
    values (_employee, _month, amt, coalesce(emp_salary, 0), d, m, eid, _expense is null, note)
    returning id into pid;
  exception when unique_violation then
    -- two phones linking the same expense at once
    raise exception 'That expense is already linked to a salary payment';
  end;
  return pid;
end $$;
revoke execute on function public.salary_mark_paid(uuid, text, numeric, date, text, uuid, text) from public, anon;
grant execute on function public.salary_mark_paid(uuid, text, numeric, date, text, uuid, text) to authenticated;

-- 4. Undo a month: its payments go, and so do the expenses payroll created
--    for them (out of Expenses and the Daily Closing). Hand-typed expenses
--    that were only linked stay — that cash really went out. Returns the
--    number of payments removed.
create or replace function public.salary_mark_unpaid(_employee uuid, _month text)
returns integer language plpgsql set search_path = public as $$
declare
  n integer;
  created uuid[];
begin
  if _month is null or _month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Month must look like YYYY-MM (got %)', coalesce(_month, 'nothing');
  end if;
  with gone as (
    delete from public.salary_payments s
    where s.employee_id = _employee and s.month = _month
    returning s.expense_id, s.expense_created
  )
  select count(*)::integer,
         coalesce(array_agg(g.expense_id) filter (where g.expense_created and g.expense_id is not null), '{}')
    into n, created
  from gone g;
  if cardinality(created) > 0 then
    delete from public.expenses x where x.id = any(created);
  end if;
  return n;
end $$;
revoke execute on function public.salary_mark_unpaid(uuid, text) from public, anon;
grant execute on function public.salary_mark_unpaid(uuid, text) to authenticated;

-- 5. When an employee left. Set by the app when they are made inactive
--    (cleared when reactivated), so the months they still worked keep
--    showing as due instead of vanishing the moment they leave.
alter table public.employees add column if not exists left_on date;

notify pgrst, 'reload schema';

-- Admin access managed from the app (Admin → Users) + the profile phone field.
-- Safe to re-run (idempotent; nothing is dropped).
--
-- The shop was set up with a developer's admin login. Rather than baking
-- anyone's email or password into the code, admins now grant and revoke
-- admin access themselves: the owner signs up (or resets the password) with
-- their own email, an existing admin grants it admin in Admin → Users, and
-- the developer account is revoked once the owner's login works.

-- 1. Profile phone. "Save profile" on Admin → Profile writes it; the column
--    was missing, so saving the profile failed.
alter table public.profiles add column if not exists phone text;

-- 2. Admins may grant and revoke roles (insert / delete rows). There is no
--    update policy: a role is changed by revoking one and granting another.
--    Everyone else can still only add the plain customer role to their own
--    account at sign-up ("roles self customer").
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'roles admin insert') then
    create policy "roles admin insert" on public.user_roles for insert to authenticated
      with check (public.has_role((select auth.uid()), 'admin'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'roles admin delete') then
    create policy "roles admin delete" on public.user_roles for delete to authenticated
      using (public.has_role((select auth.uid()), 'admin'));
  end if;
end $$;

-- 3. Never lock everyone out: removing the last admin role is refused, from
--    the app or anywhere else. The advisory lock makes two admins revoking
--    each other at the same moment take turns, so one of them is refused.
create or replace function public.user_roles_keep_one_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' then
    perform pg_advisory_xact_lock(hashtext('public.user_roles_keep_one_admin'));
    if not exists (select 1 from public.user_roles r where r.role = 'admin' and r.id <> old.id) then
      raise exception 'At least one admin must remain' using errcode = 'P0001',
        hint = 'Grant admin to another account before revoking this one.';
    end if;
  end if;
  return old;
end $$;
revoke execute on function public.user_roles_keep_one_admin() from public, anon;

create or replace trigger user_roles_keep_one_admin
  before delete on public.user_roles
  for each row execute function public.user_roles_keep_one_admin();

-- 4. Every sign-in account for Admin → Users, including accounts that never
--    got a profile row, with roles and last sign-in. Admins only.
create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  roles text[]
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.has_role(auth.uid(), 'admin'), false) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select u.id,
           coalesce(u.email, p.email)::text,
           p.full_name,
           u.created_at,
           u.last_sign_in_at,
           coalesce(
             array(select r.role::text from public.user_roles r where r.user_id = u.id order by r.role::text),
             '{}'::text[]
           )
      from auth.users u
      left join public.profiles p on p.id = u.id
     order by u.created_at desc nulls last;
end $$;
revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- Product clean-up: sold-out junk out of the database, history kept.
--
-- Sold-out products cluttered every list and picker, and deleting one by hand
-- blanked the product on its old sale lines, purchases and sales history
-- (stock_purchases / customer_purchases keep no name of their own) and lost
-- its prices — so restocking it meant typing it in again as a duplicate.
-- From here on:
--   * a sold-out product that never did anything (no sale, purchase, quote,
--     amanat or stock count) is purged — it is just a name;
--   * a product with history can no longer be deleted: the app hides it from
--     every browse list while it is out of stock (typing its name still finds
--     it) and it comes back by itself when stock is booked, so restocking
--     reuses the same record;
--   * one product per name (normalised: trimmed, single spaces, any case).
--
-- Duplicate-name copies are folded together by the merge in
-- RUN_THIS_IN_SUPABASE.sql (20261004 §2). That merge re-points every ledger
-- row to the keeper before deleting the copies, so the guard below never
-- blocks it. Copies are left for the merge here (their image, description or
-- category may be what the keeper lacks); re-running this file after the
-- merge purges a keeper that is junk too.
--
-- Needs 20261015000000_stock_ledger.sql (track_stock, stock_adjustments).
-- Safe to re-run (idempotent, no drops).

-- 1. Indexes for the history checks (sale lines, purchases and counts are
--    indexed by 20261015; these three were not).
create index if not exists customer_purchases_product_id_idx on public.customer_purchases (product_id);
create index if not exists quotation_items_product_id_idx    on public.quotation_items (product_id);
create index if not exists amanat_items_product_id_idx       on public.amanat_items (product_id);

-- 2. Purge sold-out products with no history at all: a stock-tracked product
--    at or below zero (or, as 20261004 §3 already did, an untracked bare name
--    with no price, image, description, category, brand or website flag)
--    that was never sold, bought, quoted, given on amanat or counted.
--    Untracked services/trade-ins with a price are always sellable and stay.
--    A product added in the last week is left alone: it may have been
--    entered ahead of its first delivery.
delete from public.products p
where coalesce(p.quantity_in_stock, 0) <= 0
  and p.created_at < now() - interval '7 days'
  and (p.track_stock is distinct from false
       or (coalesce(p.selling_price, 0) = 0 and coalesce(p.purchase_price, 0) = 0
           and coalesce(p.image_url, '') = '' and coalesce(p.description, '') = ''
           and p.category_id is null and p.brand_id is null
           and not coalesce(p.is_featured, false) and not coalesce(p.is_deal, false)))
  and not exists (select 1 from public.invoice_items      x where x.product_id = p.id)
  and not exists (select 1 from public.customer_purchases x where x.product_id = p.id)
  and not exists (select 1 from public.stock_purchases    x where x.product_id = p.id)
  and not exists (select 1 from public.quotation_items    x where x.product_id = p.id)
  and not exists (select 1 from public.amanat_items       x where x.product_id = p.id)
  and not exists (select 1 from public.stock_adjustments  x where x.product_id = p.id)
  -- a duplicate-name copy is the merge's to fold into its keeper
  and not exists (
    select 1 from public.products o
    where o.id <> p.id
      and lower(regexp_replace(trim(o.product_name), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(p.product_name), '\s+', ' ', 'g')));

-- 3. A product with history is kept for the records. Its sale lines,
--    purchases, sales history, quotations and amanat entries would otherwise
--    lose the product (ON DELETE SET NULL) — and with it the purchase and
--    sales figures per product. Stock counts alone do not block a delete
--    (they cascade with the product). SECURITY DEFINER so the check sees
--    every row whatever the caller's row-level security allows.
create or replace function public.products_keep_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.invoice_items      where product_id = old.id)
     or exists (select 1 from public.stock_purchases    where product_id = old.id)
     or exists (select 1 from public.customer_purchases where product_id = old.id)
     or exists (select 1 from public.quotation_items    where product_id = old.id)
     or exists (select 1 from public.amanat_items       where product_id = old.id) then
    raise exception 'This product has sales or purchase history and is kept for the records; it stays hidden while out of stock and returns when restocked.'
      using errcode = 'P0001',
            detail = format('product %s (%s)', old.id, coalesce(old.product_name, '')),
            hint = 'Re-point or delete its sale, purchase, quotation and amanat rows first.';
  end if;
  return old;
end $$;
revoke execute on function public.products_keep_history() from public, anon, authenticated;

create or replace trigger products_keep_history
  before delete on public.products
  for each row execute function public.products_keep_history();

-- 4. One product per name, so re-entering a product can never create a
--    conflicting copy (the app already reuses an existing name). Skipped with
--    a notice until the duplicate merge has folded the old copies together.
do $$
begin
  if exists (
    select 1 from public.products
    group by lower(regexp_replace(trim(product_name), '\s+', ' ', 'g')) having count(*) > 1
  ) then
    raise notice 'duplicate product names remain — unique name index skipped; run the duplicate merge (RUN_THIS_IN_SUPABASE.sql) first';
  else
    create unique index if not exists products_name_norm_uidx
      on public.products ((lower(regexp_replace(trim(product_name), '\s+', ' ', 'g'))));
  end if;
end $$;

notify pgrst, 'reload schema';

-- Live dashboard: publish the tables the dashboard listens to.
--
-- The dashboard subscribes to Supabase Realtime (postgres_changes) and
-- reloads its figures a moment after a sale, payment, expense, purchase or
-- stock correction lands. Realtime only sends changes for tables that are
-- members of the supabase_realtime publication, which had none.
--
-- Safe to re-run: the publication is created only when missing, and each
-- table is added only when it exists and is not a member yet (adding a
-- member twice is an error). Nothing is dropped. A publication defined
-- FOR ALL TABLES already covers every table and is left alone.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach t in array array[
    'invoices', 'invoice_items', 'invoice_payments', 'customer_purchases',
    'client_ledger', 'expenses', 'stock_purchases', 'stock_adjustments', 'products'
  ] loop
    if to_regclass(format('public.%I', t)) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Deleting products.
--
-- Products → Delete works for every product. A product that never did
-- anything (no sale, purchase, quotation or amanat) is erased. One with
-- history is marked deleted instead (deleted_at): it leaves the Products
-- list, the POS, every product picker, the stock lists and the website,
-- while its old invoices, purchases, ledgers and reports keep showing it.
-- Erasing it would blank the product on those rows, which
-- products_keep_history (20261020000300) refuses.
--
-- A deleted product is restored from Products → Deleted products, by
-- entering its name again (one product per name — the app brings the old
-- record back instead of making a copy), or by booking a purchase of it
-- (below): stock arriving means the shop carries it again.
--
-- Safe to re-run (no drops).

alter table public.products add column if not exists deleted_at timestamptz;

create or replace function public.products_restore_on_purchase()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.products set deleted_at = null
   where id = new.product_id and deleted_at is not null;
  return null;
end $$;
revoke execute on function public.products_restore_on_purchase() from public, anon, authenticated;

create or replace trigger products_restore_on_purchase
  after insert or update of product_id on public.stock_purchases
  for each row execute function public.products_restore_on_purchase();

notify pgrst, 'reload schema';

-- One product per name, ignoring spaces and punctuation.
--
-- Battery models had been entered twice with names that differ only in a
-- space ("HT 200 Osaka 21p" / "Ht200 osaka 21p", "XP 100 phoenix 11p" /
-- "Xp100 phoenix 11p"). The earlier duplicate merge folded names that differ
-- in case and spacing between words, not these. Purchases landed on one copy
-- and sales on the other, so the copy the POS sold from showed 0 or below
-- while the units sat on its twin, and each copy's stock history showed only
-- half of that product's movements.
--
-- Each such group becomes one product: the copy that is actually sold (most
-- sale lines, then the latest activity) keeps its name and prices, every
-- purchase, sale line, sales-history row, quotation line, stock count and
-- amanat entry of the other copies moves to it — the stock-ledger triggers
-- move their units along — and whatever it lacks (image, description,
-- category, brand, prices) is taken from the copies. The emptied copies are
-- marked deleted (20261111), not erased. Then a unique index keeps a second
-- copy of a name (spaces and punctuation ignored) from being entered again.
--
-- Needs 20261015 (stock ledger), 20261020 (amanat) and 20261111 (deleted_at).
-- Safe to re-run: with no groups left it changes nothing.

do $$
declare
  grp record;
  keeper uuid;
  others uuid[];
begin
  for grp in
    select lower(regexp_replace(product_name, '[^[:alnum:]]+', '', 'g')) as k, array_agg(id) as ids
    from public.products
    where deleted_at is null
    group by 1
    having count(*) > 1 and lower(regexp_replace(min(product_name), '[^[:alnum:]]+', '', 'g')) <> ''
  loop
    select p.id into keeper
    from public.products p
    where p.id = any(grp.ids)
    order by (select count(*) from public.invoice_items ii where ii.product_id = p.id) desc,
             greatest(
               (select max(i.created_at) from public.invoice_items ii
                  join public.invoices i on i.id = ii.invoice_id where ii.product_id = p.id),
               (select max(sp.created_at) from public.stock_purchases sp where sp.product_id = p.id)
             ) desc nulls last,
             coalesce(p.quantity_in_stock, 0) desc, p.created_at desc, p.id
    limit 1;
    others := array_remove(grp.ids, keeper);

    -- Counts first, so an amanat entry moved below finds its units already
    -- booked on the keeper and its stock sync has nothing left to add.
    update public.stock_adjustments  set product_id = keeper where product_id = any(others);
    update public.stock_purchases    set product_id = keeper where product_id = any(others);
    update public.invoice_items      set product_id = keeper where product_id = any(others);
    update public.customer_purchases set product_id = keeper where product_id = any(others);
    update public.quotation_items    set product_id = keeper where product_id = any(others);
    update public.amanat_items       set product_id = keeper where product_id = any(others);

    update public.products k set
      image_url      = coalesce(nullif(k.image_url, ''),   o.image_url),
      description    = coalesce(nullif(k.description, ''), o.description),
      category_id    = coalesce(k.category_id,    o.category_id),
      subcategory_id = coalesce(k.subcategory_id, o.subcategory_id),
      brand_id       = coalesce(k.brand_id,       o.brand_id),
      selling_price  = case when coalesce(k.selling_price, 0)  > 0 then k.selling_price  else o.selling_price end,
      purchase_price = case when coalesce(k.purchase_price, 0) > 0 then k.purchase_price else o.purchase_price end,
      is_featured    = coalesce(k.is_featured, false) or o.is_featured
    from (
      select max(nullif(c.image_url, ''))      as image_url,
             max(nullif(c.description, ''))    as description,
             max(c.category_id::text)::uuid    as category_id,
             max(c.subcategory_id::text)::uuid as subcategory_id,
             max(c.brand_id::text)::uuid       as brand_id,
             max(coalesce(c.selling_price, 0))  as selling_price,
             max(coalesce(c.purchase_price, 0)) as purchase_price,
             coalesce(bool_or(c.is_featured), false) as is_featured
      from public.products c where c.id = any(others)
    ) o
    where k.id = keeper;

    update public.products set deleted_at = now(), is_featured = false, is_deal = false
     where id = any(others);
  end loop;

  -- Every product back on its ledger figure (moves above already did this).
  perform public.stock_resync();

  -- One product per name among the products the shop carries. Skipped with a
  -- notice if a clash remains (then the app's name check still applies).
  if exists (
    select 1 from public.products where deleted_at is null
    group by lower(regexp_replace(product_name, '[^[:alnum:]]+', '', 'g')) having count(*) > 1
  ) then
    raise notice 'products differing only in spaces/punctuation remain — unique name-key index skipped';
  else
    create unique index if not exists products_name_key_uidx
      on public.products ((lower(regexp_replace(product_name, '[^[:alnum:]]+', '', 'g'))))
      where deleted_at is null;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Profit needs the cost of every sale line.
--
-- invoice_items.cost_price (per unit) is what the invoice's internal profit
-- and the profit & loss read; a line saved without a cost counts as 100%
-- profit. Products sold without ever going through Stock Purchases (oils,
-- old tyres and batteries taken in, rims, services) had no cost on record,
-- and Quick POS had nowhere to enter one, so a Rs 4,600 sale of an item
-- bought for Rs 4,400 showed Rs 4,600 profit instead of Rs 200.
--
-- 1. A sale line saved without a cost takes the product's cost (whatever
--    screen or app version wrote it). Still unknown → left empty (null).
-- 2. When a product gets a cost (Quick POS, Products page, a purchase),
--    its earlier sale lines that have none take it, so past invoices and
--    the monthly profit correct themselves. Lines that carry a cost are
--    never changed.
-- 3. Sale lines with no cost whose product already has one are filled now.
--
-- customer_purchases (the per-item sales history) follows the same rules.
-- Safe to re-run.

create or replace function public.sale_line_cost()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.cost_price, 0) <= 0 then
    new.cost_price := (select p.purchase_price from public.products p
                        where p.id = new.product_id and p.purchase_price > 0);
  end if;
  return new;
end $$;
revoke execute on function public.sale_line_cost() from public, anon, authenticated;

create or replace trigger invoice_items_cost
  before insert on public.invoice_items
  for each row execute function public.sale_line_cost();
create or replace trigger customer_purchases_cost
  before insert on public.customer_purchases
  for each row execute function public.sale_line_cost();

create or replace function public.products_fill_sale_costs()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.purchase_price > 0 and new.purchase_price is distinct from old.purchase_price then
    update public.invoice_items set cost_price = new.purchase_price
     where product_id = new.id and coalesce(cost_price, 0) <= 0;
    update public.customer_purchases set cost_price = new.purchase_price
     where product_id = new.id and coalesce(cost_price, 0) <= 0;
  end if;
  return null;
end $$;
revoke execute on function public.products_fill_sale_costs() from public, anon, authenticated;

create or replace trigger products_fill_sale_costs
  after update of purchase_price on public.products
  for each row execute function public.products_fill_sale_costs();

update public.invoice_items ii set cost_price = p.purchase_price
  from public.products p
 where p.id = ii.product_id and p.purchase_price > 0 and coalesce(ii.cost_price, 0) <= 0;
update public.customer_purchases cp set cost_price = p.purchase_price
  from public.products p
 where p.id = cp.product_id and p.purchase_price > 0 and coalesce(cp.cost_price, 0) <= 0;

notify pgrst, 'reload schema';
