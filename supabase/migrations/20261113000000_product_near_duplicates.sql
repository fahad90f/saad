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
