import { inStock, type StockFields } from "@/lib/stock";

/**
 * Percentage-based price adjustment: products carry a company/base price and
 * a bill can add or deduct a percentage per transaction.
 * pct is signed: +10 adds 10%, -5 deducts 5%.
 *
 * Precision: the exact figure is kept to the paisa. Rounding to whole rupees
 * silently changed the amount (24,660 +6% is 26,139.60, not 26,140) and those
 * few rupees add up over a bulk purchase.
 */

/** Round to the nearest paisa without float drift (0.1 + 0.2 problems). */
export const toPaisa = (n: number | string | null | undefined) =>
  Math.round((Number(n) || 0) * 100) / 100;

/** Sum a list of amounts and keep the result exact to the paisa. */
export const sumMoney = (values: Array<number | string | null | undefined>) =>
  values.reduce((a: number, v) => a + Math.round((Number(v) || 0) * 100), 0) / 100;

export const applyPct = (base: number, pct: number) => {
  const b = Number(base) || 0;
  const p = Number(pct) || 0;
  if (p === 0) return toPaisa(b);              // no % -> price is the base, untouched
  // Work in paise so 24660 +6% lands on 26139.60 exactly, with no float tail.
  return Math.round(Math.round(b * 100) * (1 + p / 100)) / 100;
};

/** Reverse: what percentage turns `base` into `price` (1 decimal). */
export const impliedPct = (base: number, price: number) =>
  base > 0 ? Math.round((price / base - 1) * 1000) / 10 : 0;

/**
 * In-stock products first, out-of-stock at the very end — every product
 * list and picker in the app follows this one rule, so what can actually
 * be sold is always in front. Alphabetical within each group unless a
 * different tiebreak (e.g. newest first) is given. Returns a copy.
 */
export const inStockFirst = <T extends StockFields & { product_name?: string | null }>(
  list: T[],
  tiebreak: (a: T, b: T) => number = (a, b) => (a.product_name ?? "").localeCompare(b.product_name ?? ""),
): T[] =>
  [...list].sort((a, b) => {
    // Untracked products (services, trade-ins) are always sellable.
    const inA = inStock(a);
    const inB = inStock(b);
    if (inA !== inB) return inA ? -1 : 1;
    return tiebreak(a, b);
  });

/**
 * The price a product sells at in POS/sales forms: its selling price when
 * one is set, otherwise the latest purchase (merchant) price. Products
 * booked in through a stock purchase get a price without extra data entry.
 */
export const effectivePrice = (p: { selling_price?: number | string | null; purchase_price?: number | string | null } | null | undefined) => {
  if (!p) return 0;
  const sell = Number(p.selling_price) || 0;
  return sell > 0 ? toPaisa(sell) : toPaisa(p.purchase_price);
};

/**
 * One product per name: the name's letters and digits, lower-cased — spaces,
 * punctuation and case are ignored, so "HT 200 Osaka 21p" and
 * "Ht200 osaka 21p" are the same product. Matches the unique name-key index
 * on `products` (20261113), so a quick-add that spells an existing name
 * differently reuses that product instead of starting a second stock count.
 */
export const normalizeProductName = (name: string | null | undefined) =>
  (name ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
