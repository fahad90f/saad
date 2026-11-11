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
