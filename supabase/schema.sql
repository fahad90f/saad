create extension if not exists pgcrypto;

drop table if exists public.customer_purchases cascade;
drop table if exists public.invoice_payments cascade;
drop table if exists public.stock_adjustments cascade;
drop table if exists public.invoice_items cascade;
drop table if exists public.invoices cascade;
drop table if exists public.stock_purchases cascade;
drop table if exists public.expenses cascade;
drop table if exists public.testimonials cascade;
drop table if exists public.products cascade;
drop table if exists public.brands cascade;
drop table if exists public.subcategories cascade;
drop table if exists public.categories cascade;
drop table if exists public.user_roles cascade;
drop table if exists public.profiles cascade;
drop table if exists public.client_ledger cascade;
drop table if exists public.clients cascade;
drop table if exists public.merchant_ledger cascade;
drop table if exists public.merchants cascade;
drop table if exists public.salary_payments cascade;
drop table if exists public.employees cascade;
drop table if exists public.reports_inbox cascade;
drop table if exists public.templates cascade;
drop table if exists public.amanat_items cascade;
drop table if exists public.daily_closings cascade;
drop table if exists public.quotation_items cascade;
drop table if exists public.quotations cascade;
drop type if exists public.app_role cascade;

create type public.app_role as enum ('admin', 'customer');

create sequence if not exists public.client_account_no_seq start 1001;
create sequence if not exists public.merchant_account_no_seq start 1001;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  unique (user_id, role)
);

create table public.categories (
  icon text,
  created_at timestamptz not null default now(),
  display_order integer,
  id uuid primary key default gen_random_uuid(),
  name text,
  slug text
);

create table public.subcategories (
  category_id uuid not null references public.categories(id) on delete cascade,
  slug text,
  name text,
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  unique(category_id, slug)
);

create table public.brands (
  logo_url text,
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text
);

create table public.products (
  last_purchase_date date,
  selling_price numeric,
  image_url text,
  id uuid primary key default gen_random_uuid(),
  purchase_price numeric,
  product_name text,
  quantity_in_stock integer not null default 0,
  track_stock boolean not null default true,
  description text,
  brand_id uuid references public.brands(id) on delete set null,
  subcategory_id uuid,
  category_id uuid references public.categories(id) on delete set null,
  deal_end_date timestamptz,
  is_deal boolean,
  created_at timestamptz not null default now(),
  is_featured boolean,
  -- Products → Delete on a product with history (20261111): hidden, history kept
  deleted_at timestamptz
);

create table public.expenses (
  amount numeric,
  created_at timestamptz not null default now(),
  expense_type text,
  notes text,
  id uuid primary key default gen_random_uuid(),
  date_of_expense date default current_date
);

create table public.stock_purchases (
  date date default current_date,
  quantity integer,
  id uuid primary key default gen_random_uuid(),
  purchase_price numeric,
  supplier_name text,
  product_id uuid references public.products(id) on delete set null,
  created_at timestamptz not null default now(),
  reference text,
  merchant_id uuid
);

create table public.testimonials (
  id uuid primary key default gen_random_uuid(),
  avatar_url text,
  message text,
  created_at timestamptz not null default now(),
  rating integer,
  customer_name text
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  payment_method text,
  payment_status text,
  total_amount numeric,
  created_at timestamptz not null default now(),
  customer_id uuid,
  invoice_id text,
  customer_name text,
  client_id uuid,
  due_date date
);

create table public.invoice_items (
  total_price numeric,
  product_name text,
  unit_price numeric,
  quantity integer,
  product_id uuid references public.products(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete cascade,
  id uuid primary key default gen_random_uuid(),
  cost_price numeric
);

-- Counts and corrections; with stock_purchases (in) and invoice_items (out)
-- these ledgers are the truth for products.quantity_in_stock, which the
-- stock_ledger_* triggers (migration 20261015) keep in step.
create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  delta integer not null,
  reason text not null default 'Correction',
  note text,
  created_at timestamptz not null default now()
);

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric not null,
  method text not null default 'cash',
  payment_date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create table public.customer_purchases (
  payment_due_date date,
  id uuid primary key default gen_random_uuid(),
  customer_id uuid,
  product_id uuid references public.products(id) on delete set null,
  quantity_purchased integer,
  total_price numeric,
  purchase_date date,
  payment_status text,
  payment_method text,
  customer_name text,
  created_at timestamptz not null default now(),
  cost_price numeric
);

create table public.clients (
  account_no text unique default ('CUST-' || nextval('public.client_account_no_seq')),
  cnic text,
  notes text,
  name text,
  phone text,
  email text,
  address text,
  id uuid primary key default gen_random_uuid(),
  opening_balance numeric,
  current_balance numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.merchants (
  account_no text unique default ('MER-' || nextval('public.merchant_account_no_seq')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  id uuid primary key default gen_random_uuid(),
  notes text,
  cnic text,
  address text,
  email text,
  phone text,
  name text,
  opening_balance numeric,
  current_balance numeric
);

create table public.client_ledger (
  id uuid primary key default gen_random_uuid(),
  entry_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  entry_type text,
  note text,
  reference text,
  client_id uuid references public.clients(id) on delete restrict,
  amount numeric,
  method text
);

create table public.merchant_ledger (
  reference text,
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references public.merchants(id) on delete restrict,
  amount numeric,
  entry_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  note text,
  entry_type text,
  method text
);

create table public.employees (
  position text,
  phone text,
  name text,
  status text,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  joining_date date,
  salary numeric,
  id uuid primary key default gen_random_uuid(),
  email text,
  cnic text,
  -- set when made inactive, cleared when reactivated (payroll keeps the
  -- months they still worked due)
  left_on date
);

create table public.reports_inbox (
  from_email text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  id uuid primary key default gen_random_uuid(),
  from_name text,
  from_phone text,
  subject text,
  message text,
  status text
);

create table public.templates (
  category_id uuid references public.categories(id) on delete set null,
  id uuid primary key default gen_random_uuid(),
  notes text,
  description text,
  name text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  default_price numeric,
  image_url text
);

create sequence if not exists public.quotation_no_seq start 1001;

create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  quote_no text unique default ('QUO-' || nextval('public.quotation_no_seq')),
  customer_name text not null,
  client_id uuid references public.clients(id) on delete set null,
  status text not null default 'draft',
  valid_until date,
  notes text,
  total_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null default 1,
  unit_price numeric not null default 0,
  total_price numeric not null default 0
);

alter table public.stock_purchases
  add constraint stock_purchases_merchant_id_fkey
  foreign key (merchant_id) references public.merchants(id) on delete set null;

create index if not exists stock_purchases_reference_idx on public.stock_purchases (reference);
create index if not exists stock_purchases_merchant_id_idx on public.stock_purchases (merchant_id);
create index if not exists quotation_items_quotation_id_idx on public.quotation_items (quotation_id);
create index if not exists invoice_payments_invoice_id_idx on public.invoice_payments (invoice_id);
create index if not exists invoice_items_product_id_idx on public.invoice_items (product_id);
create index if not exists stock_purchases_product_id_idx on public.stock_purchases (product_id);
create index if not exists stock_adjustments_product_id_idx on public.stock_adjustments (product_id);
create index if not exists invoice_payments_payment_date_idx on public.invoice_payments (payment_date);
create index if not exists invoices_client_id_idx on public.invoices (client_id);
create index if not exists client_ledger_client_id_idx on public.client_ledger (client_id);
create index if not exists client_ledger_entry_date_idx on public.client_ledger (entry_date);
create index if not exists merchant_ledger_merchant_id_idx on public.merchant_ledger (merchant_id);
create index if not exists merchant_ledger_entry_date_idx on public.merchant_ledger (entry_date);

create table public.daily_closings (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  net_sales numeric not null default 0,
  cash_sales numeric not null default 0,
  credit_sales numeric not null default 0,
  recoveries numeric not null default 0,
  total_cash_in numeric not null default 0,
  merchant_payments numeric not null default 0,
  expenses numeric not null default 0,
  net_cash numeric not null default 0,
  cash_in_hand numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists public.amanat_no_seq start 1001;

create table public.amanat_items (
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
  -- 'pending' = still open, 'received' = settled
  status text not null default 'pending' constraint amanat_items_status_chk check (status in ('pending', 'received')),
  returned_date date,
  returned_quantity integer not null default 0,
  notes text,
  -- Customer or Merchant Amanat (migration 20261020000000)
  party_type text not null default 'client' constraint amanat_items_party_type_chk check (party_type in ('client', 'merchant')),
  merchant_id uuid references public.merchants(id) on delete set null,
  -- 'taken' = the party took our item/money; 'left' = they left theirs with us
  direction text not null default 'taken' constraint amanat_items_direction_chk check (direction in ('taken', 'left')),
  kind text not null default 'item' constraint amanat_items_kind_chk check (kind in ('item', 'money')),
  amount numeric,
  contact text,
  from_stock boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint amanat_items_party_chk check ((party_type = 'client' and merchant_id is null) or (party_type = 'merchant' and client_id is null)),
  constraint amanat_items_money_amount_chk check (kind <> 'money' or coalesce(amount, 0) > 0),
  constraint amanat_items_quantity_chk check (quantity > 0),
  constraint amanat_items_returned_qty_chk check (returned_quantity between 0 and quantity)
);
create index if not exists amanat_items_merchant_idx on public.amanat_items (merchant_id);

-- An item taken out of shelf stock on amanat is booked as dated
-- stock_adjustments rows (given out, each return), linked by amanat_id.
alter table public.stock_adjustments add column amanat_id uuid references public.amanat_items(id) on delete cascade;
create index if not exists stock_adjustments_amanat_id_idx
  on public.stock_adjustments (amanat_id) where amanat_id is not null;

-- Monthly payroll (migration 20261020000100): one row per salary payment;
-- every payment is also an expense, exactly once.
create table public.salary_payments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric not null check (amount > 0),
  salary_due numeric not null default 0,
  paid_date date not null default current_date,
  method text not null default 'cash',
  expense_id uuid unique references public.expenses(id) on delete cascade,
  expense_created boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists salary_payments_month_idx on public.salary_payments (month);
create index if not exists salary_payments_employee_month_idx on public.salary_payments (employee_id, month);
