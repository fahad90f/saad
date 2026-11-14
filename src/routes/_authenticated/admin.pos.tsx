import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, shortDate, localToday } from "@/lib/format";
import { PAYMENT_METHODS, methodLabel, summarizeMethods, paymentStatus } from "@/lib/payments";
import { effectivePrice, inStockFirst } from "@/lib/pricing";
import { hiddenFromBrowse, inStock, isTracked, stockOf, stockLabel } from "@/lib/stock";
import { getOrCreateProduct, confirmStockForSale } from "@/lib/products";
import { matchesQuery } from "@/lib/search";
import { printArea } from "@/lib/print";
import { SearchableSelect } from "@/components/admin/SearchableSelect";
import { InvoiceQuickView } from "@/components/admin/InvoiceQuickView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Search, Plus, Minus, Trash2, Zap, Banknote, SplitSquareHorizontal, Printer } from "lucide-react";
import { COMPANY } from "@/lib/company";
import { fetchAll } from "@/lib/fetchAll";
import { useLiveReload } from "@/lib/useLiveReload";

export const Route = createFileRoute("/_authenticated/admin/pos")({
  component: PosPage,
});

// `cost` is the purchase price of one unit. Until the cashier types one
// (`costTouched`) the product's live cost is used, so a cost entered on
// another screen or device meanwhile is picked up.
type CartLine = { product_id: string; name: string; qty: number; price: number; cost: number | null; costTouched?: boolean; stock: number };
type PayLine = { method: string; amount: number };

function PosPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [clientId, setClientId] = useState("");
  const [saleDate, setSaleDate] = useState(() => localToday());
  const [splitMode, setSplitMode] = useState(false);
  // "" = auto: the whole bill in cash. Typing an amount records exactly what
  // was received; the rest becomes udhar on the linked account.
  const [cashReceived, setCashReceived] = useState("");
  const [payLines, setPayLines] = useState<PayLine[]>([{ method: "cash", amount: 0 }]);
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<string | null>(null);
  const [viewInvoice, setViewInvoice] = useState<string | null>(null);
  const [stockPrint, setStockPrint] = useState(false);

  // Deleted products (Products → Delete) are not sold here.
  const fetchProducts = (quiet = false) =>
    fetchAll((a, b) => supabase.from("products").select("id, product_name, selling_price, purchase_price, quantity_in_stock, track_stock")
      .is("deleted_at", null).order("product_name").order("id").range(a, b), 1000, { quiet });
  const load = async () => {
    const [{ data: p }, { data: c }] = await Promise.all([
      fetchProducts(),
      supabase.from("clients").select("id, name, account_no, current_balance").order("name"),
    ]);
    setProducts(p ?? []); setClients(c ?? []);
  };
  useEffect(() => { load(); }, []);

  // Stock and prices stay current while the page is open: a purchase booked,
  // a sale made or a price changed on another device (the phone, the shop
  // laptop) shows here within seconds, without reloading the page. A failed
  // background refresh keeps the list on screen. The cart is left alone.
  useLiveReload(["products", "stock_purchases", "invoice_items", "stock_adjustments"], () => {
    void fetchProducts(true).then(({ data, error }) => { if (!error) setProducts(data); });
  });

  // Every typed word must appear in the name, in any order — so
  // "Bandalayar 12 Evergreen" and "Evergreen Bandalayar 12" both match.
  // Products with stock come first (alphabetical); out-of-stock ones sink
  // to the very bottom so the sellable items are always in front.
  // Browsing shows only what can be sold right now (untracked services and
  // trade-ins always can); a typed search still finds out-of-stock products
  // (sorted last) so nothing is ever lost.
  const [showOutOfStock, setShowOutOfStock] = useState(false);
  const matches = useMemo(() => {
    if (q.trim()) return inStockFirst(products.filter((p) => matchesQuery(p.product_name, q)));
    return inStockFirst(showOutOfStock ? products : products.filter(inStock));
  }, [products, q, showOutOfStock]);
  const filtered = useMemo(() => matches.slice(0, q.trim() ? 60 : 30), [matches, q]);

  // Render the print-only stock list, then hand it to the browser.
  useEffect(() => {
    if (!stockPrint) return;
    const t = setTimeout(() => { printArea(); setStockPrint(false); }, 80);
    return () => clearTimeout(t);
  }, [stockPrint]);

  const total = cart.reduce((a, l) => a + l.qty * l.price, 0);
  const paid = splitMode
    ? payLines.reduce((a, l) => a + (Number(l.amount) || 0), 0)
    : (cashReceived === "" ? total : Math.max(0, Number(cashReceived) || 0));
  const remaining = Math.max(0, total - paid);
  const status = paymentStatus(total, paid);

  const addToCart = (p: any) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product_id === p.id);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
      return [...c, {
        product_id: p.id, name: p.product_name, qty: 1,
        price: effectivePrice(p), cost: Number(p.purchase_price) > 0 ? Number(p.purchase_price) : null,
        stock: stockOf(p),
      }];
    });
  };
  const setCartLine = (i: number, patch: Partial<CartLine>) =>
    setCart((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Quick-add from the search box. A name that already exists (any spacing
  // or case) reuses that product — the shop must never carry two copies.
  const createProduct = async (name: string) => {
    const { product, created, error } = await getOrCreateProduct(name);
    if (error || !product) return toast.error(error ?? "Could not add product");
    // A deleted product of this name comes back restored: refresh its row.
    setProducts((ps) => (ps.some((p) => p.id === product.id)
      ? ps.map((p) => (p.id === product.id ? { ...p, ...product } : p)) : [...ps, product]));
    addToCart(product);
    toast.success(created
      ? `New product "${product.product_name}" added — set its price in the cart`
      : `"${product.product_name}" already exists — added it to the cart`);
  };

  // The typed cart price becomes the product's shop price, so the cashier
  // stops retyping it on every sale.
  const saveAsProductPrice = async (line: CartLine) => {
    const price = Math.round(Number(line.price) || 0);
    if (!(price > 0)) return toast.error("Enter a price first");
    const { data, error } = await supabase.from("products").update({ selling_price: price })
      .eq("id", line.product_id).select("id").maybeSingle();
    if (error) return toast.error(error.message);
    if (!data) return toast.error("Product not found — refresh the page");
    setProducts((ps) => ps.map((p) => (p.id === line.product_id ? { ...p, selling_price: price } : p)));
    toast.success(`${line.name}: shop price saved as ${money(price)}`);
  };

  // The cost of one unit on a cart line: what the cashier typed, else the
  // product's current cost; null while unknown.
  const productCost = (id: string) => {
    const c = Number(products.find((p) => p.id === id)?.purchase_price);
    return c > 0 ? c : null;
  };
  const lineCost = (l: CartLine) => (l.costTouched ? (Number(l.cost) > 0 ? Number(l.cost) : null) : productCost(l.product_id) ?? l.cost);
  const uncostedLines = cart.filter((l) => lineCost(l) == null).length;
  const billProfit = cart.reduce((a, l) => {
    const c = lineCost(l);
    return c == null ? a : a + l.qty * (Number(l.price) - c);
  }, 0);

  // The typed cost becomes the product's purchase price; its earlier sales
  // that had no cost take it too (database), so their profit corrects itself.
  const saveAsProductCost = async (line: CartLine) => {
    const cost = Number(line.cost);
    if (!(cost > 0)) return toast.error("Enter the cost first");
    const { data, error } = await supabase.from("products").update({ purchase_price: cost })
      .eq("id", line.product_id).select("id").maybeSingle();
    if (error) return toast.error(error.message);
    if (!data) return toast.error("Product not found — refresh the page");
    setProducts((ps) => ps.map((p) => (p.id === line.product_id ? { ...p, purchase_price: cost } : p)));
    toast.success(`${line.name}: cost saved as ${money(cost)}`);
  };

  const reset = () => {
    setCart([]); setCustomerName(""); setClientId(""); setSaleDate(localToday());
    setSplitMode(false); setCashReceived(""); setPayLines([{ method: "cash", amount: 0 }]); setDueDate("");
  };

  const complete = async () => {
    if (cart.length === 0) return toast.error("Cart is empty");
    if (cart.some((l) => !(l.price > 0))) return toast.error("Set a price for every item");
    if (paid > total) return toast.error("Payments exceed the total");
    if (remaining > 0 && !clientId)
      return toast.error("Credit (udhar) sale — link a customer account so the balance is tracked");

    const name = customerName.trim() ||
      (clientId ? clients.find((c) => c.id === clientId)?.name ?? "Walk-in customer" : "Walk-in customer");
    const activePays: PayLine[] = (splitMode
      ? payLines
      : [{ method: "cash", amount: paid }]).filter((l) => Number(l.amount) > 0);
    const methodSummary = summarizeMethods(activePays.map((l) => l.method));
    const txDate = saleDate || localToday();

    setSaving(true);
    try {
      // Live stock check: the list on screen may be stale (another device
      // may have sold meanwhile). Selling past zero needs a yes.
      if (!(await confirmStockForSale(cart.map((l) => ({ product_id: l.product_id, qty: l.qty }))))) return;

      // Each line's cost for the profit: the cost typed on the line, else the
      // product's cost as it is right now (fresh read — never a stale 0).
      // Unknown stays empty, never 0: a 0 would count the sale as all profit.
      const ids = [...new Set(cart.map((l) => l.product_id))];
      const { data: costRows } = await supabase.from("products").select("id, purchase_price").in("id", ids);
      const liveCost = new Map((costRows ?? []).map((p) => [p.id, Number(p.purchase_price) > 0 ? Number(p.purchase_price) : null]));
      const costOf = (l: CartLine) => (l.costTouched && Number(l.cost) > 0 ? Number(l.cost) : liveCost.get(l.product_id) ?? null);

      const invId = "INV-" + Date.now();
      const { data: inv, error } = await supabase.from("invoices").insert({
        invoice_id: invId, customer_name: name, total_amount: total,
        payment_method: methodSummary, payment_status: status,
        client_id: clientId || null,
        due_date: remaining > 0 && dueDate ? dueDate : null,
        // Backdated sale: file the invoice under the chosen day (midday keeps
        // it on that local date in every timezone-sensitive report).
        ...(txDate !== localToday() ? { created_at: new Date(`${txDate}T12:00:00`).toISOString() } : {}),
      }).select().maybeSingle();
      if (error || !inv) return toast.error(error?.message ?? "Could not create invoice");

      const { error: itemsErr } = await supabase.from("invoice_items").insert(cart.map((l) => ({
        invoice_id: inv.id, product_id: l.product_id, product_name: l.name,
        quantity: l.qty, unit_price: l.price, total_price: l.qty * l.price,
        cost_price: costOf(l),
      })));
      if (itemsErr) {
        await supabase.from("invoices").delete().eq("id", inv.id);
        return toast.error(itemsErr.message);
      }

      if (activePays.length > 0 && total > 0) {
        await supabase.from("invoice_payments").insert(
          activePays.map((l) => ({ invoice_id: inv.id, amount: Number(l.amount), method: l.method, payment_date: txDate })),
        );
      }

      // Stock: the invoice_items trigger has already taken the sold units
      // off products.quantity_in_stock — nothing to write here.

      // Per-item sale rows feed the dashboard/reports — never fail silently.
      const { error: cpErr } = await supabase.from("customer_purchases").insert(cart.map((l) => ({
        customer_name: name, product_id: l.product_id,
        quantity_purchased: l.qty, total_price: l.qty * l.price,
        cost_price: costOf(l), payment_method: methodSummary, payment_status: status,
        purchase_date: txDate,
        payment_due_date: remaining > 0 && dueDate ? dueDate : null,
      })));
      if (cpErr) toast.error(`Sale saved, but the sales history row failed: ${cpErr.message}`);

      // A product sold with a typed cost but none on record keeps that cost,
      // so the next sale knows it (and older sales without a cost take it).
      for (const l of cart) {
        if (l.costTouched && Number(l.cost) > 0 && liveCost.get(l.product_id) == null) {
          await supabase.from("products").update({ purchase_price: Number(l.cost) }).eq("id", l.product_id);
        }
      }

      if (clientId) {
        await supabase.from("client_ledger").insert({
          client_id: clientId, entry_type: "sale", amount: total,
          reference: invId, note: cart.map((l) => `${l.name} × ${l.qty}`).join("; "),
          entry_date: txDate,
        });
        if (activePays.length > 0) {
          await supabase.from("client_ledger").insert(
            activePays.map((l) => ({
              client_id: clientId, entry_type: "payment", amount: Number(l.amount),
              method: l.method, reference: invId, note: `Paid at sale (${methodLabel(l.method)})`,
              entry_date: txDate,
            })),
          );
        }
      }

      toast.success(remaining > 0
        ? `Sale done — ${money(remaining)} udhar (${invId})`
        : `Sale done — ${money(total)} received (${invId})`);
      setLastInvoice(invId);
      setViewInvoice(invId);
      reset();
      load();
    } finally {
      setSaving(false);
    }
  };

  const stockUnits = matches.reduce((a, p) => a + (isTracked(p) ? Math.max(0, stockOf(p)) : 0), 0);
  // The printed sheet is what is on the shelf (narrowed by the search, if
  // any): stock-tracked products with units in stock. Sold-out products are
  // only counted in the footer and services/trade-ins are never on a shelf.
  const printScope = useMemo(
    () => (q.trim() ? products.filter((p) => matchesQuery(p.product_name, q)) : products),
    [products, q],
  );
  const printList = useMemo(() => printScope.filter((p) => isTracked(p) && stockOf(p) > 0), [printScope]);
  const printOutOfStock = printScope.filter(hiddenFromBrowse).length;
  const printUnits = printList.reduce((a, p) => a + stockOf(p), 0);

  return (
    <AdminShell title="Quick Sale (POS)">
      <div className="grid lg:grid-cols-5 gap-4">
        {/* Product picker */}
        <div className="lg:col-span-3 rounded-2xl bg-card p-4 shadow-sm">
          {/* Search gets a full row of its own on every screen size; the
              toggles sit below so the box is never squeezed on a phone. */}
          <div className="space-y-2 mb-3">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input autoFocus placeholder="Search product... (any word order)" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 h-11 w-full" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant={showOutOfStock ? "secondary" : "outline"} size="sm" onClick={() => setShowOutOfStock((v) => !v)}
                      title="Browse out-of-stock products too (a search always finds them)">
                {showOutOfStock ? "Hide out of stock" : "Show out of stock"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setStockPrint(true)}
                      title="Print the products in stock (matching the search, if any)">
                <Printer className="h-4 w-4 mr-2" /> Print stock list
              </Button>
            </div>
          </div>
          {q.trim() && (
            <div className="mb-2 text-xs text-muted-foreground">
              {matches.length} product{matches.length === 1 ? "" : "s"} · {stockUnits} unit{stockUnits === 1 ? "" : "s"} in stock
              {matches.length > filtered.length ? ` — showing first ${filtered.length}, print for the full list` : ""}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto pr-1">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => addToCart(p)}
                      className="rounded-xl border p-3 text-left hover:border-primary hover:bg-primary/5 transition-colors">
                <div className="text-sm font-medium leading-tight line-clamp-2">{p.product_name}</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-primary">
                    {money(effectivePrice(p))}
                    {/* No shop price yet — the tile shows the merchant cost. */}
                    {!(Number(p.selling_price) > 0) && effectivePrice(p) > 0 && (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground" title="No selling price set — showing the merchant cost">cost</span>
                    )}
                  </span>
                  <span className={inStock(p) ? "text-muted-foreground" : "text-destructive"}>
                    {stockLabel(p)}
                  </span>
                </div>
              </button>
            ))}
            {filtered.length === 0 && q.trim() && (
              <button onClick={() => createProduct(q.trim())}
                      className="rounded-xl border border-dashed p-3 text-left hover:border-primary transition-colors col-span-full">
                <div className="flex items-center gap-2 text-sm text-primary font-medium">
                  <Plus className="h-4 w-4" /> Add “{q.trim()}” as a new product
                </div>
              </button>
            )}
          </div>
        </div>

        {/* Cart / bill */}
        <div className="lg:col-span-2 rounded-2xl bg-card p-4 shadow-sm space-y-3 h-fit">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold flex items-center gap-2"><Zap className="h-4 w-4 text-gold" /> Bill</div>
            <div className="flex items-center gap-1.5">
              <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Sale date</Label>
              <Input type="date" value={saleDate} max={localToday()} className="h-8 w-36 text-xs"
                     onChange={(e) => e.target.value && setSaleDate(e.target.value)} />
            </div>
          </div>
          {saleDate !== localToday() && (
            <div className="rounded-lg bg-primary/5 border border-primary/30 px-3 py-1.5 text-xs">
              This sale will be recorded under <b>{shortDate(saleDate)}</b>, not today.
            </div>
          )}

          {cart.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Tap products to add them here.</div>
          ) : (
            <div className="space-y-2">
              {cart.map((l, i) => (
                <div key={l.product_id} className="rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium leading-tight flex-1 min-w-0 truncate">{l.name}</div>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setCart(cart.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground">Quantity</div>
                      <div className="flex items-center rounded-lg border h-9">
                        <button className="px-2.5 h-full hover:bg-muted rounded-l-lg" onClick={() => setCartLine(i, { qty: Math.max(1, l.qty - 1) })}><Minus className="h-3.5 w-3.5" /></button>
                        <Input type="number" className="h-full flex-1 border-0 text-center px-1" value={l.qty}
                               onChange={(e) => setCartLine(i, { qty: Math.max(1, Number(e.target.value) || 1) })} />
                        <button className="px-2.5 h-full hover:bg-muted rounded-r-lg" onClick={() => setCartLine(i, { qty: l.qty + 1 })}><Plus className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground">Price (Rs)</div>
                      <Input type="number" className="h-9" placeholder="0" value={l.price || ""}
                             onChange={(e) => setCartLine(i, { price: Number(e.target.value) })} />
                    </div>
                  </div>
                  {(() => {
                    const prod = products.find((p) => p.id === l.product_id);
                    const saved = Math.round(Number(prod?.selling_price) || 0);
                    const typed = Math.round(Number(l.price) || 0);
                    if (!prod || !(typed > 0) || typed === saved) return null;
                    return (
                      <button type="button" onClick={() => saveAsProductPrice(l)}
                              className="mt-1.5 text-[11px] text-primary underline-offset-2 hover:underline"
                              title={saved > 0 ? `Product price is ${money(saved)} — make ${money(typed)} the new shop price` : "This product has no shop price yet"}>
                        Save {money(typed)} as product price
                      </button>
                    );
                  })()}
                  {(() => {
                    // The live stock of this product (refreshed while the page is open).
                    const prod = products.find((p) => p.id === l.product_id);
                    if (!prod || !isTracked(prod)) return null;
                    const left = stockOf(prod);
                    return (
                      <div className={`mt-1.5 text-[11px] ${left >= l.qty ? "text-muted-foreground" : "text-destructive font-semibold"}`}>
                        {left > 0 ? `${left} in stock` : "Out of stock"}
                        {left < l.qty && ` — selling ${l.qty}${left > 0 ? `, ${l.qty - left} more than in stock` : ""}`}
                      </div>
                    );
                  })()}
                  {(() => {
                    // Internal: what one unit cost us, and the line's profit.
                    // Never printed on the slip.
                    const cost = lineCost(l);
                    const saved = productCost(l.product_id);
                    const shown = l.costTouched ? (l.cost ?? "") : (cost ?? "");
                    return (
                      <div className="mt-2 grid grid-cols-2 gap-2 items-end">
                        <div className="space-y-1">
                          <div className="text-[11px] text-muted-foreground">Cost each (Rs)</div>
                          <Input type="number" className={`h-9 ${cost == null ? "border-orange-400" : ""}`} placeholder="Purchase price"
                                 value={shown} onChange={(e) => setCartLine(i, { cost: e.target.value === "" ? null : Number(e.target.value), costTouched: true })} />
                        </div>
                        <div className="text-right text-[11px] leading-tight pb-1">
                          {cost == null ? (
                            <span className="text-orange-600">Enter the cost to see the profit</span>
                          ) : (
                            <>
                              <span className="text-muted-foreground">Profit </span>
                              <b className={l.qty * (Number(l.price) - cost) >= 0 ? "text-green-600" : "text-destructive"}>{money(l.qty * (Number(l.price) - cost))}</b>
                            </>
                          )}
                          {l.costTouched && cost != null && saved == null && (
                            <div className="text-muted-foreground mt-0.5">Saved as the product's cost with this sale</div>
                          )}
                          {l.costTouched && cost != null && saved != null && Math.round(cost) !== Math.round(saved) && (
                            <button type="button" onClick={() => saveAsProductCost(l)}
                                    className="mt-0.5 text-primary underline-offset-2 hover:underline"
                                    title={`Product cost is ${money(saved)} — make ${money(cost)} the new cost`}>
                              Save {money(cost)} as product cost
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-[11px] text-muted-foreground">Line total</div>
                    <div className="text-sm font-bold">{money(l.qty * l.price)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between items-center text-lg font-black border-t pt-2">
            <span>Total</span><span>{money(total)}</span>
          </div>
          {cart.length > 0 && (
            <div className="flex justify-between items-center text-xs -mt-1">
              <span className="text-muted-foreground">
                Profit (internal){uncostedLines > 0 && <span className="text-orange-600"> · {uncostedLines} item{uncostedLines === 1 ? "" : "s"} without a cost not counted</span>}
              </span>
              <b className={billProfit >= 0 ? "text-green-600" : "text-destructive"}>{money(billProfit)}</b>
            </div>
          )}

          {/* Customer — optional for cash sales */}
          <details className="rounded-xl border p-3" open={!!clientId || !!customerName}>
            <summary className="text-xs uppercase tracking-wider text-muted-foreground cursor-pointer select-none">
              Customer (optional — walk-in by default)
            </summary>
            <div className="mt-2 space-y-2">
              <Input placeholder="Customer name (optional)" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              <SearchableSelect
                options={clients.map((c) => ({
                  value: c.id, label: `${c.account_no ? `${c.account_no} · ` : ""}${c.name}`,
                  hint: Number(c.current_balance) > 0 ? `owes ${money(c.current_balance)}` : undefined,
                }))}
                value={clientId}
                onValueChange={(v) => {
                  const c = clients.find((x) => x.id === v);
                  setClientId(v);
                  if (!customerName) setCustomerName(c?.name ?? "");
                }}
                placeholder="Account (needed only for udhar)"
                searchPlaceholder="Search by ID, name..."
              />
            </div>
          </details>

          {/* Payment */}
          {!splitMode ? (
            <div className="rounded-xl border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5"><Banknote className="h-4 w-4 text-green-600" /> Cash received now (Rs)</Label>
                <Button variant="outline" size="sm" onClick={() => { setSplitMode(true); setPayLines([{ method: "cash", amount: paid }]); }}>
                  <SplitSquareHorizontal className="h-4 w-4 mr-1" /> Split methods
                </Button>
              </div>
              <Input type="number" className="h-10 font-semibold" placeholder={total ? `${total} (full bill)` : "0"}
                     value={cashReceived}
                     onChange={(e) => setCashReceived(e.target.value)} />
              <div className="text-[11px] text-muted-foreground">
                Leave blank for the full bill in cash — or type what was actually received; the rest stays as udhar on the account.
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Cash: <b className="text-foreground">{money(paid)}</b></span>
                <span className={remaining > 0 ? "text-orange-500 font-semibold" : "text-green-600 font-semibold"}>
                  {remaining > 0 ? `Udhar: ${money(remaining)}` : "Fully paid"}
                </span>
              </div>
              {remaining > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Due date</Label>
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label>Payments</Label>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPayLines([...payLines, { method: "cash", amount: 0 }])}>
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setSplitMode(false); setCashReceived(""); setPayLines([{ method: "cash", amount: 0 }]); }}>
                    Cash only
                  </Button>
                </div>
              </div>
              {payLines.map((l, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Select value={l.method} onValueChange={(v) => setPayLines((ls) => ls.map((x, j) => j === i ? { ...x, method: v } : x))}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input type="number" placeholder="Amount" value={l.amount || ""}
                         onChange={(e) => setPayLines((ls) => ls.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} />
                  {payLines.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => setPayLines(payLines.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Paid: <b className="text-foreground">{money(paid)}</b></span>
                <span className={remaining > 0 ? "text-orange-500 font-semibold" : "text-green-600 font-semibold"}>
                  {remaining > 0 ? `Udhar: ${money(remaining)}` : "Fully paid"}
                </span>
              </div>
              {remaining > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Due date</Label>
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </div>
              )}
            </div>
          )}

          <Button className="w-full h-12 text-base font-bold" onClick={complete} disabled={saving || cart.length === 0}>
            {saving ? "Saving..." : remaining > 0 ? `Complete — ${money(remaining)} udhar` : `Complete sale — ${money(total)}`}
          </Button>
          {lastInvoice && (
            <Button variant="outline" className="w-full" onClick={() => setViewInvoice(lastInvoice)}>
              Print last invoice ({lastInvoice})
            </Button>
          )}
        </div>
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
                {q.trim() ? ` · search: “${q.trim()}”` : " · products in stock"}
                {` · ${printList.length} product${printList.length === 1 ? "" : "s"} · ${printUnits} unit${printUnits === 1 ? "" : "s"}`}
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase border-b">
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-2">Product</th>
                  <th className="py-1.5 pr-2 text-right">Price</th>
                  <th className="py-1.5 text-right">In stock</th>
                </tr>
              </thead>
              <tbody>
                {/* Paper copy stays alphabetical — it's a lookup sheet, not a
                    picking list, so the on-screen stock-first order would only
                    make products harder to find. */}
                {[...printList].sort((a, b) => (a.product_name ?? "").localeCompare(b.product_name ?? "")).map((p, i) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-1.5 pr-2">{i + 1}</td>
                    <td className="py-1.5 pr-2">{p.product_name}</td>
                    <td className="py-1.5 pr-2 text-right">{money(effectivePrice(p))}</td>
                    <td className="py-1.5 text-right font-semibold">{stockOf(p)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  <td className="py-2" colSpan={3}>Total units</td>
                  <td className="py-2 text-right">{printUnits}</td>
                </tr>
                {printOutOfStock > 0 && (
                  <tr>
                    <td className="pt-1 text-xs" colSpan={4}>
                      {printOutOfStock} out-of-stock product{printOutOfStock === 1 ? "" : "s"} not listed
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
