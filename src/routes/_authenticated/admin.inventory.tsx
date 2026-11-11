import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, shortDate, localDateOf, localToday } from "@/lib/format";
import { matchesQuery } from "@/lib/search";
import { effectivePrice } from "@/lib/pricing";
import { stockOf, isTracked, inStock, oversold, stockLabel, hiddenFromBrowse, activeProducts, isDeleted } from "@/lib/stock";
import { printArea } from "@/lib/print";
import { InvoiceQuickView, InvoiceRefLink } from "@/components/admin/InvoiceQuickView";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowDownToLine, ArrowUpFromLine, Package, AlertTriangle, Search, X, Printer } from "lucide-react";
import { COMPANY } from "@/lib/company";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/_authenticated/admin/inventory")({
  component: Inventory,
});

type Movement = {
  key: string;
  date: string | null;
  type: "in" | "out";
  /** purchase (stock_purchases), sale (invoice_items) or a count/correction (stock_adjustments). */
  kind: "purchase" | "sale" | "adjustment";
  productId: string | null;
  product: string;
  qty: number;
  /** Unit price; null for counts and corrections (no money moved). */
  unit: number | null;
  party: string;
  detail: string | null;
  ref: string | null;
};

type Adjustment = { id: string; product_id: string; delta: number; reason: string | null; note: string | null; created_at: string | null };

/**
 * How a stock adjustment reads in the movement list. The one-time stock
 * ledger backfill recorded the old register's starting figures as
 * adjustments with technical notes; they explain today's stock (the
 * per-product totals add up only with them), so they are listed — as plain
 * "Opening stock".
 */
function adjustmentLabel(a: Adjustment): { party: string; detail: string | null } {
  const note = a.note ?? "";
  if (a.reason === "Opening stock") {
    return {
      party: "Opening stock",
      detail: Number(a.delta) > 0 ? "Old register count with no purchase entry" : "Sold before this system was used (old register)",
    };
  }
  if (note.startsWith("Starting stock entered on the Products page")) {
    return { party: "Opening stock", detail: "Count entered on the Products page" };
  }
  return { party: a.reason || "Stock correction", detail: a.note || null };
}

function Inventory() {
  const [products, setProducts] = useState<any[]>([]);
  const [stockIn, setStockIn] = useState<any[]>([]);
  const [stockOut, setStockOut] = useState<any[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [tab, setTab] = useState("all");
  // Set by clicking a product name in the list; shown as a removable chip.
  const [productFilter, setProductFilter] = useState("");
  const [q, setQ] = useState("");
  const [stockPrint, setStockPrint] = useState(false);
  const [viewInvoice, setViewInvoice] = useState<string | null>(null);

  // Render the print-only stock list, then hand it to the browser.
  useEffect(() => {
    if (!stockPrint) return;
    const t = setTimeout(() => { printArea(); setStockPrint(false); }, 80);
    return () => clearTimeout(t);
  }, [stockPrint]);

  useEffect(() => {
    (async () => {
      const [{ data: p }, { data: sin }, { data: sout }, { data: adj }] = await Promise.all([
        fetchAll((a, b) => supabase.from("products").select("id, product_name, quantity_in_stock, track_stock, purchase_price, selling_price").order("product_name").order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("stock_purchases").select("*, products(product_name), merchants(name)").order("date", { ascending: false }).order("created_at", { ascending: false }).order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("invoice_items").select("*, invoices(invoice_id, customer_name, created_at)").order("id", { ascending: false }).order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("stock_adjustments").select("id, product_id, delta, reason, note, created_at").order("created_at", { ascending: false }).order("id").range(a, b)),
      ]);
      setProducts(p ?? []); setStockIn(sin ?? []); setStockOut(sout ?? []); setAdjustments((adj ?? []) as Adjustment[]);
    })();
  }, []);

  const nameOf = useMemo(() => new Map<string, string>(products.map((p) => [p.id, p.product_name ?? "—"])), [products]);

  // Every way stock moves: purchases in, sale lines out, and the counts and
  // corrections (opening stock, physical counts, damaged units, amanat) in
  // or out by their sign — together they are exactly the stock figure.
  const movements: Movement[] = useMemo(() => {
    const ins: Movement[] = stockIn.map((r) => ({
      key: `in-${r.id}`,
      date: r.date ?? (localDateOf(r.created_at) || null),
      type: "in",
      kind: "purchase",
      productId: r.product_id,
      product: r.products?.product_name ?? nameOf.get(r.product_id) ?? "—",
      qty: Number(r.quantity) || 0,
      unit: Number(r.purchase_price) || 0,
      party: r.merchants?.name ?? r.supplier_name ?? "—",
      detail: null,
      ref: r.reference,
    }));
    const outs: Movement[] = stockOut.map((r) => ({
      key: `out-${r.id}`,
      date: localDateOf(r.invoices?.created_at) || null,
      type: "out",
      kind: "sale",
      productId: r.product_id,
      product: r.product_name || "—",
      qty: Number(r.quantity) || 0,
      unit: Number(r.unit_price) || 0,
      party: r.invoices?.customer_name ?? "Walk-in",
      detail: null,
      ref: r.invoices?.invoice_id ?? null,
    }));
    const adjs: Movement[] = adjustments.filter((a) => Number(a.delta) !== 0).map((a) => {
      const d = Number(a.delta) || 0;
      const { party, detail } = adjustmentLabel(a);
      return {
        key: `adj-${a.id}`,
        date: localDateOf(a.created_at) || null,
        type: d > 0 ? "in" : "out",
        kind: "adjustment",
        productId: a.product_id,
        product: nameOf.get(a.product_id) ?? "—",
        qty: Math.abs(d),
        unit: null,
        party,
        detail,
        ref: null,
      };
    });
    return [...ins, ...outs, ...adjs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }, [stockIn, stockOut, adjustments, nameOf]);

  const filtered = useMemo(() => movements.filter((m) => {
    if (tab !== "all" && m.type !== tab) return false;
    if (productFilter && m.productId !== productFilter) return false;
    if (q.trim() && !matchesQuery(`${m.product} ${m.party} ${m.detail ?? ""} ${m.ref ?? ""}`, q)) return false;
    return true;
  }), [movements, tab, productFilter, q]);

  // The product summary follows the chosen product, or appears by itself when
  // the search has narrowed the list down to a single product.
  const focusId = productFilter
    || (filtered.length > 0 && filtered[0].productId && filtered.every((m) => m.productId === filtered[0].productId)
      ? filtered[0].productId : "")
    || "";
  const focusProduct = focusId ? products.find((p) => p.id === focusId) : undefined;
  // Totals over the product's whole history (not the tab/search), so they
  // always add up to the stock figure: received − sold ± counts = stock.
  const focusTotals = useMemo(() => {
    if (!focusId) return null;
    let received = 0, sold = 0, adjusted = 0, adjRows = 0;
    for (const r of stockIn) if (r.product_id === focusId) received += Number(r.quantity) || 0;
    for (const r of stockOut) if (r.product_id === focusId) sold += Number(r.quantity) || 0;
    for (const a of adjustments) {
      if (a.product_id !== focusId || !Number(a.delta)) continue;
      adjusted += Number(a.delta) || 0; adjRows++;
    }
    return { received, sold, adjusted, adjRows, ledger: received - sold + adjusted };
  }, [focusId, stockIn, stockOut, adjustments]);
  const chipName = productFilter ? (nameOf.get(productFilter) ?? movements.find((m) => m.productId === productFilter)?.product ?? "—") : "";

  // Only stock-tracked products count as stock: services and trade-ins are
  // sold without ever being booked in. Units on hand are never negative —
  // a product sold before its purchase was booked is simply out of stock.
  // Deleted products (Products → Delete) keep their movements above but are
  // no longer counted or listed as stock.
  const carried = activeProducts(products);
  const tracked = carried.filter(isTracked);
  const notTracked = carried.length - tracked.length;
  const outOfStock = tracked.filter(hiddenFromBrowse).length;

  // The stock list to print: what is on the shelf — every tracked product
  // with units in stock, with quantity and prices. Sold-out products are only
  // counted in the footer. The search here also matches parties/refs, so it
  // does not filter the printout; the POS page prints a search-filtered list.
  const stockList = tracked.filter((p) => stockOf(p) > 0);
  const stockListUnits = stockList.reduce((a, p) => a + stockOf(p), 0);
  const stockListValue = stockList.reduce((a, p) => a + Number(p.purchase_price ?? 0) * stockOf(p), 0);

  const narrowed = !!(q.trim() || productFilter || tab !== "all");

  return (
    <AdminShell title="Inventory / Stock Movements">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi icon={Package} label="Units in stock" value={stockListUnits.toLocaleString()} />
        <Kpi icon={Package} label="Stock value (cost)" value={money(stockListValue)} />
        <Kpi icon={ArrowDownToLine} label="Stock-in entries" value={String(stockIn.length)} green />
        <Kpi icon={AlertTriangle} label="Out of stock" value={String(outOfStock)} accent={outOfStock > 0} />
      </div>

      {/* One search box with a full row of its own (as on the POS); the
          direction tabs and the print button sit below it. */}
      <div className="space-y-2 mb-3">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search product, party or ref… (any word order)" value={q}
                 onChange={(e) => setQ(e.target.value)} className="pl-9 pr-9 h-11 w-full" />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">All movements</TabsTrigger>
              <TabsTrigger value="in">Stock In</TabsTrigger>
              <TabsTrigger value="out">Stock Out</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={() => setStockPrint(true)}
                  title="Print the stock list — every product in stock with its quantity and prices">
            <Printer className="h-4 w-4 mr-2" /> Print stock list
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {productFilter && (
          <button type="button" onClick={() => setProductFilter("")} title="Show every product again"
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/15">
            Product: {chipName} <X className="h-3.5 w-3.5" />
          </button>
        )}
        <span>
          {filtered.length} movement{filtered.length === 1 ? "" : "s"}{narrowed ? " match" : ""}
          {!productFilter && " · tap a product name to see only its movements and totals"}
        </span>
      </div>

      {focusProduct && focusTotals && (
        <div className="mb-4 rounded-2xl bg-primary/5 border border-primary/20 p-4 text-sm space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="col-span-2 lg:col-span-1 min-w-0">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Product</div>
              <b className="break-words">{focusProduct.product_name}</b>
              {isDeleted(focusProduct) && <span className="ml-1.5 text-[10px] rounded-full bg-destructive/10 text-destructive px-2 py-0.5 font-semibold">Deleted</span>}
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Current stock</div>
              <b className={inStock(focusProduct) ? "" : "text-destructive"}>{stockLabel(focusProduct)}</b>
              {oversold(focusProduct) > 0 && (
                <div className="text-[11px] text-destructive">{oversold(focusProduct)} oversold — book the purchase</div>
              )}
            </div>
            <div><div className="text-[10px] uppercase text-muted-foreground tracking-wider">Total received</div><b className="text-green-600">{focusTotals.received}</b></div>
            <div><div className="text-[10px] uppercase text-muted-foreground tracking-wider">Total sold / issued</div><b className="text-orange-500">{focusTotals.sold}</b></div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Counts &amp; corrections</div>
              <b>{focusTotals.adjusted > 0 ? "+" : ""}{focusTotals.adjusted}</b>
              <div className="text-[11px] text-muted-foreground">
                {focusTotals.adjRows} entr{focusTotals.adjRows === 1 ? "y" : "ies"} (opening stock, counts, damaged, amanat)
              </div>
            </div>
          </div>
          {isTracked(focusProduct) ? (
            <div className="text-xs text-muted-foreground">
              {focusTotals.received} received − {focusTotals.sold} sold {focusTotals.adjusted < 0 ? "−" : "+"} {Math.abs(focusTotals.adjusted)} counts &amp; corrections
              {" = "}<b className="text-foreground">{focusTotals.ledger}</b>
              {focusTotals.ledger === stockOf(focusProduct)
                ? " — matches the stock figure."
                : ` — the stock figure says ${stockOf(focusProduct)}; refresh the page (something changed while it loaded).`}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Not stock-tracked (service / trade-in) — always sellable, no shelf stock to keep.
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl bg-card shadow-sm overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Date</th><th className="p-3">Direction</th><th className="p-3">Product</th>
              <th className="p-3">Qty</th><th className="p-3">Unit price</th><th className="p-3">Amount</th>
              <th className="p-3">From / To</th><th className="p-3">Ref</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 300).map((m) => (
              <tr key={m.key} className="border-t">
                <td className="p-3 whitespace-nowrap">{shortDate(m.date)}</td>
                <td className="p-3">
                  {m.type === "in"
                    ? <span className="inline-flex items-center gap-1 text-green-600 font-medium"><ArrowDownToLine className="h-3.5 w-3.5" /> In</span>
                    : <span className="inline-flex items-center gap-1 text-orange-500 font-medium"><ArrowUpFromLine className="h-3.5 w-3.5" /> Out</span>}
                </td>
                <td className="p-3 font-medium">
                  {m.productId ? (
                    <button type="button" onClick={() => setProductFilter(m.productId!)}
                            title="Show only this product's movements and totals"
                            className="text-left underline-offset-2 hover:text-primary hover:underline">
                      {m.product}
                    </button>
                  ) : m.product}
                </td>
                {/* The direction column says in/out; the quantity is always
                    the positive number of units moved, never "−3", which
                    reads as negative stock. */}
                <td className={`p-3 font-semibold ${m.type === "in" ? "text-green-600" : "text-orange-500"}`}>
                  {m.qty}
                </td>
                <td className="p-3">{m.unit == null ? <span className="text-muted-foreground">—</span> : money(m.unit)}</td>
                <td className="p-3 font-semibold">{m.unit == null ? <span className="text-muted-foreground font-normal">—</span> : money(m.unit * m.qty)}</td>
                <td className="p-3 text-muted-foreground">
                  <div>{m.party}</div>
                  {m.detail && <div className="text-[11px] max-w-[240px] truncate" title={m.detail}>{m.detail}</div>}
                </td>
                <td className="p-3 font-mono text-xs text-muted-foreground">
                  {m.ref ? <InvoiceRefLink value={m.ref} onOpen={setViewInvoice} known={m.kind === "sale"} /> : "—"}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-muted-foreground">No movements found.</td></tr>}
          </tbody>
        </table>
        {filtered.length > 300 && (
          <div className="p-3 text-xs text-muted-foreground text-center border-t">
            Showing latest 300 of {filtered.length} movements — search to narrow down.
          </div>
        )}
      </div>

      {/* Print-only stock list: hidden on screen; printArea() clones the
          .print-area child, so the wrapper's `hidden` never reaches print. */}
      {stockPrint && (
        <div className="hidden">
          <div className="print-area">
            <div className="border-b-2 border-foreground pb-2 mb-3">
              <div className="text-lg font-black">{COMPANY.name} — Stock List</div>
              <div className="text-sm">
                {shortDate(localToday())}
                {` · products in stock · ${stockList.length} product${stockList.length === 1 ? "" : "s"} · ${stockListUnits} unit${stockListUnits === 1 ? "" : "s"}`}
                {notTracked > 0 && ` · ${notTracked} service / trade-in item${notTracked === 1 ? "" : "s"} not stock-tracked, not listed`}
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase border-b">
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-2">Product</th>
                  <th className="py-1.5 pr-2 text-right">Purchase price</th>
                  <th className="py-1.5 pr-2 text-right">Selling price</th>
                  <th className="py-1.5 pr-2 text-right">In stock</th>
                  <th className="py-1.5 text-right">Stock value</th>
                </tr>
              </thead>
              <tbody>
                {stockList.map((p, i) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-1.5 pr-2">{i + 1}</td>
                    <td className="py-1.5 pr-2">{p.product_name}</td>
                    <td className="py-1.5 pr-2 text-right">{money(p.purchase_price)}</td>
                    <td className="py-1.5 pr-2 text-right">{money(effectivePrice(p))}</td>
                    <td className="py-1.5 pr-2 text-right font-semibold">{stockOf(p)}</td>
                    <td className="py-1.5 text-right">{money(Number(p.purchase_price ?? 0) * stockOf(p))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  <td className="py-2" colSpan={4}>Total</td>
                  <td className="py-2 pr-2 text-right">{stockListUnits}</td>
                  <td className="py-2 text-right">{money(stockListValue)}</td>
                </tr>
                {outOfStock > 0 && (
                  <tr>
                    <td className="pt-1 text-xs" colSpan={6}>
                      {outOfStock} out-of-stock product{outOfStock === 1 ? "" : "s"} not listed
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <InvoiceQuickView invoiceRef={viewInvoice} onClose={() => setViewInvoice(null)} />
    </AdminShell>
  );
}

function Kpi({ icon: Icon, label, value, green, accent }: { icon: any; label: string; value: string; green?: boolean; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</div>
        <Icon className={`h-4 w-4 ${accent ? "text-orange-500" : green ? "text-green-600" : "text-primary"}`} />
      </div>
      <div className={`text-xl font-black mt-1 ${accent ? "text-orange-500" : ""}`}>{value}</div>
    </div>
  );
}
