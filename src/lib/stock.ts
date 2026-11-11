// Stock helpers shared by the admin screens and the website.
//
// products.quantity_in_stock is kept by the database from the ledgers
// (stock purchases in, sale lines out, counts/corrections) — the app never
// writes it. It can sit below zero when units were sold before their
// purchase was booked; every screen shows that as "Out of stock".

export type StockFields = { quantity_in_stock?: number | null; track_stock?: boolean | null };

/** Units on hand. */
export const stockOf = (p: StockFields) => Number(p.quantity_in_stock) || 0;

/**
 * Services, trade-ins and consumables that are sold without ever being
 * booked in (battery charging, wheel balancing, old tyres taken in) are not
 * stock-tracked: always sellable, never "out of stock".
 */
export const isTracked = (p: StockFields) => p.track_stock !== false;

/** Sellable / showable as available right now. */
export const inStock = (p: StockFields) => !isTracked(p) || stockOf(p) > 0;

/** Units sold before their purchase was booked (tracked products only). */
export const oversold = (p: StockFields) => (isTracked(p) && stockOf(p) < 0 ? -stockOf(p) : 0);

/** Short label for lists: "7 left", "Out of stock" or "Not tracked". */
export const stockLabel = (p: StockFields) =>
  !isTracked(p) ? "Not tracked" : stockOf(p) > 0 ? `${stockOf(p)} left` : "Out of stock";

/**
 * The one rule every browse list and picker follows: a stock-tracked product
 * with nothing on the shelf is left out of browsing (no clutter), but a typed
 * search still finds it, so restocking or selling reuses the same record
 * instead of creating a duplicate. It comes back by itself once stock is
 * booked. Untracked products (services, trade-ins) are always sellable and
 * never hidden by this rule.
 */
export const hiddenFromBrowse = (p: StockFields) => isTracked(p) && stockOf(p) <= 0;

/**
 * Deleted on the Products page. A product with sales or purchase history is
 * never erased (its old invoices, purchases and reports still show it); it
 * is marked deleted instead and left out of every product list, picker,
 * stock figure and the website. Restored from Products → Deleted products,
 * by entering its name again, or by booking a purchase of it.
 */
export const isDeleted = (p: { deleted_at?: string | null }) => !!p.deleted_at;

/** The products the shop still carries (not deleted). */
export const activeProducts = <T extends { deleted_at?: string | null }>(list: T[]) =>
  list.filter((p) => !isDeleted(p));

/**
 * Option for a SearchableSelect product picker. Products hidden from browse
 * (see hiddenFromBrowse) are search-only: out of the list until a name is
 * typed. `hideUntracked` makes services/trade-ins search-only too — noise in
 * the purchase picker, where they are never booked in. Deleted products are
 * hidden: never offered, only shown as the current choice of an old record.
 */
export function productOption(
  p: StockFields & { id: string; product_name: string | null; deleted_at?: string | null },
  hint?: string,
  { hideUntracked = false }: { hideUntracked?: boolean } = {},
): { value: string; label: string; hint: string; searchOnly: boolean; hidden: boolean } {
  return {
    value: p.id,
    label: p.product_name ?? "—",
    hint: isDeleted(p) ? "Deleted" : hint ? `${hint} · ${stockLabel(p)}` : stockLabel(p),
    searchOnly: hiddenFromBrowse(p) || (hideUntracked && !isTracked(p)),
    hidden: isDeleted(p),
  };
}
