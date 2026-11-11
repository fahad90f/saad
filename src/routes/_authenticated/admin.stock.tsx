import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, shortDate, localToday } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/admin/SearchableSelect";
import { applyPct, inStockFirst, sumMoney } from "@/lib/pricing";
import { productOption } from "@/lib/stock";
import { getOrCreateProduct } from "@/lib/products";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/_authenticated/admin/stock")({
  component: StockAdmin,
});

type PurchaseLine = { uid: string; product_id: string; quantity: number; unit_cost: number; base: number; pct: number };

/** Final price = base ± % (no % → final equals the base). Always defined. */
const finalOf = (l: { base: number; pct: number; unit_cost: number }) =>
  Number(l.base) > 0 ? applyPct(Number(l.base), Number(l.pct) || 0) : Number(l.unit_cost) || 0;

const emptyLine = (): PurchaseLine => ({ uid: crypto.randomUUID(), product_id: "", quantity: 1, unit_cost: 0, base: 0, pct: 0 });

function StockAdmin() {
  const [rows, setRows] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [merchants, setMerchants] = useState<any[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [date, setDate] = useState(() => localToday());
  const [lines, setLines] = useState<PurchaseLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);

  const [loadError, setLoadError] = useState("");

  const load = async () => {
    const [{ data: r, error: rErr }, { data: p }, { data: m }] = await Promise.all([
      fetchAll((a, b) => supabase.from("stock_purchases").select("*, products(product_name)").order("date", { ascending: false }).order("created_at", { ascending: false }).order("id").range(a, b)),
      fetchAll((a, b) => supabase.from("products").select("id, product_name, quantity_in_stock, purchase_price, selling_price, track_stock").order("id").range(a, b)),
      supabase.from("merchants").select("id, name, account_no").order("name"),
    ]);
    // An empty list used to look identical to a failed query. Say which it is.
    setLoadError(rErr ? rErr.message : "");
    setRows(r ?? []); setProducts(p ?? []); setMerchants(m ?? []);
  };
  useEffect(() => { load(); }, []);

  const setLine = (i: number, patch: Partial<PurchaseLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  /** Patch by stable id — safe after an await, when rows may have shifted. */
  const setLineByUid = (uid: string, patch: Partial<PurchaseLine>) =>
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  // Instantly create a brand-new product from the picker (first-time
  // arrivals). A name that already exists (any spacing/case) reuses that
  // product instead of creating a second copy.
  const createProduct = async (uid: string, name: string) => {
    const { product, created, error } = await getOrCreateProduct(name);
    if (error || !product) return toast.error(error ?? "Could not add product");
    // A deleted product of this name comes back restored: refresh its row.
    setProducts((ps) => (ps.some((p) => p.id === product.id)
      ? ps.map((p) => (p.id === product.id ? { ...p, ...product } : p)) : [...ps, product]));
    if (created) {
      // A brand-new product has no price yet — clear any price left over from
      // the product previously chosen on this line.
      setLineByUid(uid, { product_id: product.id, base: 0, pct: 0, unit_cost: 0 });
      toast.success(`New product "${product.product_name}" added — enter the merchant cost below`);
    } else {
      const base = Number(product.purchase_price) || Number(product.selling_price) || 0;
      setLineByUid(uid, { product_id: product.id, base, pct: 0, unit_cost: base });
      toast.success(`"${product.product_name}" already exists — selected it`);
    }
  };

  const total = sumMoney(lines.map((l) => (Number(l.quantity) || 0) * finalOf(l)));
  // Units being received on this purchase, and how many different products they cover.
  // Only lines with a product chosen count — a fresh, empty line must not read as 1 unit.
  const totalQty = lines.reduce((a, l) => a + (l.product_id ? Number(l.quantity) || 0 : 0), 0);
  const productKinds = new Set(lines.filter((l) => l.product_id).map((l) => l.product_id)).size;

  // Running totals for every purchase listed below.
  const historyQty = rows.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
  const historyTotal = sumMoney(rows.map((r) => (Number(r.quantity) || 0) * (Number(r.purchase_price) || 0)));
  const historyKinds = new Set(rows.map((r) => r.product_id).filter(Boolean)).size;

  const add = async () => {
    if (!merchantId) return toast.error("Select the merchant this stock was purchased from");
    const valid = lines.filter((l) => l.product_id && Number(l.quantity) > 0);
    if (valid.length === 0) return toast.error("Add at least one product line");
    if (lines.some((l) => !l.product_id && (Number(l.quantity) || 0) * finalOf(l) > 0))
      return toast.error("Select a product for every filled item line");
    // A line with a product but a blank/zero/fractional qty would be dropped
    // from the save while still counting in the on-screen total.
    if (lines.some((l) => l.product_id && !(Number.isInteger(Number(l.quantity)) && Number(l.quantity) > 0)))
      return toast.error("Enter a whole quantity of 1 or more for every item line");
    if (valid.some((l) => !(finalOf(l) > 0)))
      return toast.error("Enter the merchant cost for every item line");
    const supplier = supplierName || merchants.find((m) => m.id === merchantId)?.name || "";
    const validTotal = sumMoney(valid.map((l) => Number(l.quantity) * finalOf(l)));

    setSaving(true);
    try {
      const ref = "PUR-" + Date.now();
      const { error } = await supabase.from("stock_purchases").insert(valid.map((l) => ({
        date, supplier_name: supplier, product_id: l.product_id,
        quantity: Number(l.quantity), purchase_price: finalOf(l),
        reference: ref, merchant_id: merchantId,
      })));
      if (error) return toast.error(error.message);

      // The stock count itself is the database's job: the stock_purchases
      // trigger has already added these units to products.quantity_in_stock.
      // Here only the latest merchant cost and purchase date are recorded —
      // the last line for a product wins when it appears twice.
      const byProduct = new Map<string, number>();
      for (const l of valid) byProduct.set(l.product_id, finalOf(l));
      for (const [productId, unit_cost] of byProduct) {
        const name = products.find((p) => p.id === productId)?.product_name ?? "product";
        // Fresh read — the page may have been open a while and a selling
        // price set meanwhile must not be missed.
        const { data: prod } = await supabase.from("products")
          .select("selling_price").eq("id", productId).maybeSingle();
        if (prod) {
          const upd: { purchase_price: number; last_purchase_date: string; selling_price?: number } = {
            purchase_price: unit_cost,
            last_purchase_date: date,
          };
          // products.selling_price is the shop price and the only source of
          // it. A product that has never been given one would ring up as
          // Rs 0 in the POS, so it starts at the merchant cost on first
          // arrival — and is never touched again by a restock.
          if (!(Number(prod.selling_price) > 0)) upd.selling_price = Math.round(unit_cost);
          const { error: updErr } = await supabase.from("products").update(upd).eq("id", productId);
          if (updErr) toast.error(`Cost update failed for ${name}: ${updErr.message}`);
        }
      }

      const detail = valid.map((l) => {
        const p = products.find((x) => x.id === l.product_id);
        return `${p?.product_name ?? "?"} × ${l.quantity} @ ${money(finalOf(l))}`;
      }).join("; ");
      const { error: ledErr } = await supabase.from("merchant_ledger").insert({
        merchant_id: merchantId, entry_type: "purchase", amount: validTotal,
        reference: ref, note: detail, entry_date: date,
      });
      if (ledErr) toast.error(`Stock saved but ledger entry failed: ${ledErr.message}`);

      toast.success(`Purchase of ${valid.length} item${valid.length > 1 ? "s" : ""} (${money(validTotal)}) recorded`);
      setLines([emptyLine()]); setSupplierName(""); setMerchantId("");
      setDate(localToday());
      load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell title="Stock Purchases">
      <div className="grid lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 rounded-2xl bg-card p-5 shadow-sm space-y-3">
          <div className="font-semibold">Log purchase from merchant</div>
          <div className="space-y-1.5"><Label>Merchant <span className="text-destructive">*</span></Label>
            <SearchableSelect
              options={merchants.map((m) => ({ value: m.id, label: m.name, hint: m.account_no ?? undefined }))}
              value={merchantId}
              onValueChange={(v) => {
                const m = merchants.find((x) => x.id === v);
                setMerchantId(v);
                if (!supplierName) setSupplierName(m?.name ?? "");
              }}
              placeholder="Select merchant"
              searchPlaceholder="Search merchant by name or ID..."
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label>Purchase date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5"><Label>Supplier</Label>
              <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            </div>
          </div>

          <div className="rounded-xl border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label>Items purchased</Label>
              <Button type="button" variant="ghost" size="sm" onClick={() => setLines([...lines, emptyLine()])}>
                <Plus className="h-4 w-4 mr-1" /> Add item
              </Button>
            </div>
            {lines.map((l, i) => (
              <div key={l.uid} className="space-y-2.5 rounded-xl border bg-muted/20 p-3">
                <div className="flex gap-1.5 items-center">
                  <div className="flex-1 min-w-0">
                    {/* Browsing lists what is on the shelf; a sold-out product
                        (or a service) is found by typing its name, so a
                        restock lands on the same record — "Add new product"
                        never appears for a name that already exists. */}
                    <SearchableSelect
                      options={inStockFirst(products).map((p) => productOption(p, undefined, { hideUntracked: true }))}
                      hiddenNoun="out-of-stock or service item"
                      value={l.product_id}
                      onValueChange={(v) => {
                        const p = products.find((x) => x.id === v);
                        // Base = last purchase cost, else the product's list price.
                        // % is always entered manually per transaction — never carried over.
                        const base = Number(p?.purchase_price) || Number(p?.selling_price) || 0;
                        setLine(i, { product_id: v, base, pct: 0, unit_cost: base });
                      }}
                      placeholder="Product"
                      searchPlaceholder="Search any product (sold-out too) or type a new name..."
                      onCreate={(name) => createProduct(l.uid, name)}
                      createLabel="Add new product"
                    />
                  </div>
                  {lines.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Merchant cost / unit (Rs)</Label>
                    <Input type="number" step="any" placeholder="0" value={l.base || ""} onChange={(e) => {
                      const base = Number(e.target.value) || 0;
                      // Final price always follows the base (with % if one is set).
                      setLine(i, { base, unit_cost: base > 0 ? applyPct(base, l.pct) : 0 });
                    }} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Adjust % (optional)</Label>
                    <div className="relative">
                      <Input type="number" step="any" placeholder="0" className="pr-6 text-right" value={l.pct || ""} onChange={(e) => {
                        const pct = Number(e.target.value) || 0;
                        // % is optional: with no base yet, treat the typed final
                        // price as the base so the adjustment still applies.
                        const base = Number(l.base) > 0 ? Number(l.base) : Number(l.unit_cost) || 0;
                        setLine(i, { pct, base, unit_cost: base > 0 ? applyPct(base, pct) : 0 });
                      }} />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                    </div>
                  </div>
                </div>
                {/* Final price — always calculated from the base (± % if set) */}
                <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Final merchant cost / unit</div>
                    <div className="text-lg font-black text-primary">{money(finalOf(l))}</div>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {Number(l.base) > 0
                      ? (Number(l.pct) === 0
                          ? `Cost ${money(l.base)} · no % applied`
                          : `Cost ${money(l.base)} ${l.pct > 0 ? "+" : ""}${l.pct}% = ${money(finalOf(l))}`)
                      : "Enter the merchant cost above"}
                    {" · "}what you pay the merchant, not the shop price
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Qty</Label>
                    <Input type="number" min="1" step="1" placeholder="Qty" value={l.quantity || ""} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Override</Label>
                    <Input type="number" step="any" placeholder="0" value={l.unit_cost || ""} onChange={(e) => {
                      // Typing a price directly makes it the base with no %.
                      const unit_cost = Number(e.target.value) || 0;
                      setLine(i, { unit_cost, base: unit_cost, pct: 0 });
                    }} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Line total</Label>
                    <div className="h-9 rounded-md border bg-muted/40 grid place-items-center text-sm font-bold">
                      {money((Number(l.quantity) || 0) * finalOf(l))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <div className="space-y-1 pt-2 border-t">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total quantity</span>
                <b>{totalQty} {totalQty === 1 ? "unit" : "units"}</b>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total amount</span>
                <b>{money(total)}</b>
              </div>
              {productKinds > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Different products</span>
                  <span>{productKinds}</span>
                </div>
              )}
            </div>
          </div>

          <Button onClick={add} className="w-full" disabled={saving}>
            {saving ? "Saving..." : `Add stock — ${totalQty} ${totalQty === 1 ? "unit" : "units"} (${money(total)})`}
          </Button>
        </div>

        <div className="lg:col-span-3 rounded-2xl bg-card shadow-sm overflow-hidden">
          {/* Quick glance: everything received across the purchases listed below. */}
          <div className="px-4 pt-4">
            <div className="font-semibold text-sm">Stock received (all purchases)</div>
            <div className="text-xs text-muted-foreground">
              Every item ever booked in from a merchant — what came in, when, from whom and at what cost.
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 border-b">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Total quantity</div>
              <div className="text-xl font-black text-primary">{historyQty}</div>
              <div className="text-[11px] text-muted-foreground">units received</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Total amount</div>
              <div className="text-xl font-black">{money(historyTotal)}</div>
              <div className="text-[11px] text-muted-foreground">{rows.length} purchase {rows.length === 1 ? "entry" : "entries"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Different products</div>
              <div className="text-xl font-black">{historyKinds}</div>
              <div className="text-[11px] text-muted-foreground">product types</div>
            </div>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr><th className="p-3">Date</th><th className="p-3">Ref</th><th className="p-3">Supplier</th><th className="p-3">Product</th><th className="p-3">Qty</th><th className="p-3">Merchant cost</th><th className="p-3">Total</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3 whitespace-nowrap">{shortDate(r.date ?? r.created_at)}</td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">{r.reference ?? "—"}</td>
                  <td className="p-3">{r.supplier_name}</td>
                  <td className="p-3">{r.products?.product_name ?? "—"}</td>
                  <td className="p-3">{r.quantity}</td>
                  <td className="p-3">{money(r.purchase_price)}</td>
                  <td className="p-3 font-semibold">{money(Number(r.purchase_price) * r.quantity)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-sm">
                  {loadError
                    ? <span className="text-destructive">Could not load purchases: {loadError}</span>
                    : <span className="text-muted-foreground">No purchases recorded yet. Log one on the left and it will appear here.</span>}
                </td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-bold">
                  <td className="p-3" colSpan={4}>Total ({historyKinds} product {historyKinds === 1 ? "type" : "types"})</td>
                  <td className="p-3">{historyQty}</td>
                  <td className="p-3 text-muted-foreground font-normal">—</td>
                  <td className="p-3">{money(historyTotal)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
