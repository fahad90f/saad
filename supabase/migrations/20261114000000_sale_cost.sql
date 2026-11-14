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
