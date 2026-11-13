import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { normalizeProductName } from "@/lib/pricing";
import { isDeleted, isTracked, stockOf } from "@/lib/stock";

export type ProductRow = Database["public"]["Tables"]["products"]["Row"];
type ProductInsert = Database["public"]["Tables"]["products"]["Insert"];

/**
 * The product whose normalised name equals `name`, or null. The database is
 * asked for a loose ILIKE match (every letter and digit of the name, in
 * order, with anything in between) and the exact comparison happens here, so
 * spacing, punctuation and case differences ("HT 200" / "Ht200") still find
 * the one product. Until the duplicate merge
 * has run several old copies can share a name: the one with the most stock
 * wins (then the one with a shop price, then the newest), the same copy the
 * merge keeps, so restocking lands on the record that will survive. A copy
 * the shop still carries wins over a deleted one; a deleted product is still
 * found (one product per name), so entering its name again can restore it.
 */
export async function findProductByName(name: string): Promise<ProductRow | null> {
  const norm = normalizeProductName(name);
  if (!norm) return null;
  // The key holds only letters/digits, so nothing needs LIKE-escaping, and
  // over-matching is harmless (the exact check is below).
  const { data, error } = await supabase.from("products").select("*")
    .ilike("product_name", `%${[...norm].join("%")}%`).limit(500);
  if (error) throw error;
  const matches = (data ?? []).filter((p) => normalizeProductName(p.product_name) === norm);
  if (matches.length <= 1) return matches[0] ?? null;
  const rank = (a: ProductRow, b: ProductRow) =>
    Number(isDeleted(a)) - Number(isDeleted(b))
    || stockOf(b) - stockOf(a)
    || (Number(b.selling_price) || 0) - (Number(a.selling_price) || 0)
    || (b.created_at ?? "").localeCompare(a.created_at ?? "");
  return [...matches].sort(rank)[0];
}

/**
 * Bring a deleted product back into the lists (Products → Deleted products,
 * or its name entered again). Returns the restored row.
 */
export async function restoreProduct(id: string): Promise<{ product: ProductRow | null; error: string | null }> {
  const { data, error } = await supabase.from("products").update({ deleted_at: null })
    .eq("id", id).select().maybeSingle();
  if (error) {
    return { product: null, error: error.code === "23505"
      ? "another product with this name is already in the list — use that one"
      : error.message };
  }
  if (!data) return { product: null, error: "Product not found — refresh the page" };
  return { product: data, error: null };
}

/**
 * Quick-add from a picker: reuse the product that already carries this name,
 * otherwise create it. A deleted product of that name is restored rather
 * than entered twice. A race with another device (unique-name violation
 * 23505) is resolved by fetching the row the other device created.
 * Stock always starts at 0 — purchases and adjustments move it.
 */
export async function getOrCreateProduct(
  name: string,
  extra: Omit<ProductInsert, "product_name" | "quantity_in_stock"> = {},
): Promise<{ product: ProductRow | null; created: boolean; error: string | null }> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return { product: null, created: false, error: "Product name required" };
  try {
    const existing = await findProductByName(clean);
    if (existing && isDeleted(existing)) return { ...(await restoreProduct(existing.id)), created: false };
    if (existing) return { product: existing, created: false, error: null };
    const { data, error } = await supabase.from("products")
      .insert({ purchase_price: 0, selling_price: 0, ...extra, product_name: clean, quantity_in_stock: 0 })
      .select().maybeSingle();
    if (error) {
      if (error.code === "23505") {
        const again = await findProductByName(clean);
        if (again && isDeleted(again)) return { ...(await restoreProduct(again.id)), created: false };
        if (again) return { product: again, created: false, error: null };
        return { product: null, created: false, error: "A product with this name already exists" };
      }
      return { product: null, created: false, error: error.message };
    }
    if (!data) return { product: null, created: false, error: "Could not create product" };
    return { product: data, created: true, error: null };
  } catch (err) {
    return { product: null, created: false, error: err instanceof Error ? err.message : "Could not look up product" };
  }
}

/**
 * Sale-time stock check. Re-reads the live stock for the lines about to be
 * sold (the page's product list may be minutes old) and, when any line
 * sells more than is in stock, asks the cashier to confirm. Returns true to
 * go ahead. Selling past zero is allowed — the purchase may simply not be
 * booked yet — but never silently. Untracked products (track_stock = false:
 * services, trade-ins, consumables) are skipped.
 */
export async function confirmStockForSale(lines: Array<{ product_id: string | null | undefined; qty: number }>): Promise<boolean> {
  const wanted = new Map<string, number>();
  for (const l of lines) {
    if (!l.product_id) continue;
    wanted.set(l.product_id, (wanted.get(l.product_id) ?? 0) + (Number(l.qty) || 0));
  }
  if (wanted.size === 0) return true;
  const { data, error } = await supabase.from("products")
    .select("id, product_name, quantity_in_stock, track_stock").in("id", [...wanted.keys()]);
  if (error) {
    window.alert(`Could not check stock before saving: ${error.message}`);
    return false;
  }
  const shortfalls: string[] = [];
  for (const p of data ?? []) {
    if (!isTracked(p)) continue; // services / trade-ins: always sellable, never checked
    const qty = wanted.get(p.id) ?? 0;
    const stock = Number(p.quantity_in_stock) || 0;
    if (qty > stock) {
      const oversold = stock < 0 ? ` (already ${-stock} oversold)` : "";
      shortfalls.push(`${p.product_name}: only ${Math.max(0, stock)} in stock${oversold}, selling ${qty}.`);
    }
  }
  if (shortfalls.length === 0) return true;
  return window.confirm(
    `${shortfalls.join("\n")}\n\nContinue? Stock will go below zero until the purchase is booked.`,
  );
}
