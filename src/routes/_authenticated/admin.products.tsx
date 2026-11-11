import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useRef } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, localDateOf, shortDate } from "@/lib/format";
import { inStockFirst, normalizeProductName } from "@/lib/pricing";
import { hiddenFromBrowse, isDeleted, isTracked, stockOf } from "@/lib/stock";
import { matchesQuery } from "@/lib/search";
import { findProductByName, restoreProduct, type ProductRow } from "@/lib/products";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/admin/SearchableSelect";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Search, X, Undo2 } from "lucide-react";
import { ImageUpload } from "@/components/admin/ImageUpload";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/_authenticated/admin/products")({
  component: ProductsAdmin,
});

// Exactly the columns this form is allowed to write. Stock is deliberately
// absent: the database owns products.quantity_in_stock (purchases, invoice
// lines and stock_adjustments move it through triggers), so this page only
// ever books an adjustment row, never the number itself.
type ProductForm = {
  product_name: string; description: string; image_url: string;
  category_id: string; subcategory_id: string; brand_id: string;
  purchase_price: number | string; selling_price: number | string;
  // Off for services, trade-ins and consumables that are sold without ever
  // being booked in — they are always sellable and never "out of stock".
  track_stock: boolean;
  // Website visibility: featured products and "deal of the day" items.
  is_featured: boolean; is_deal: boolean; deal_end_date: string;
};
const empty: ProductForm = { product_name: "", description: "", image_url: "", category_id: "", subcategory_id: "", brand_id: "",
  purchase_price: 0, selling_price: 0, track_stock: true, is_featured: false, is_deal: false, deal_end_date: "" };

const ADJUST_REASONS = ["Physical count", "Damaged or expired", "Returned to merchant", "Correction"] as const;

function ProductsAdmin() {
  const [rows, setRows] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);
  const [form, setForm] = useState<ProductForm>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  // The name the product had when the edit dialog opened (rename check).
  const [editingName, setEditingName] = useState("");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // Browsing hides sold-out products (like the POS); a typed search always
  // finds them, so re-entering one opens the existing record.
  const [showOutOfStock, setShowOutOfStock] = useState(false);
  // Deleted products (kept for their sales/purchase records) are listed
  // only here, each with Restore.
  const [showDeleted, setShowDeleted] = useState(false);
  const [saving, setSaving] = useState(false);
  // Create: units on the shelf right now (booked as an "Opening count").
  const [openingStock, setOpeningStock] = useState("");
  // Edit: the live count when the dialog opened, and the count the owner
  // actually found — the difference becomes a stock_adjustments row.
  const [currentStock, setCurrentStock] = useState(0);
  const [counted, setCounted] = useState("");
  // Only a count the owner actually typed is booked — opening and saving the
  // dialog for a price change must never touch stock.
  const [countTouched, setCountTouched] = useState(false);
  const countTouchedRef = useRef(false);
  useEffect(() => { countTouchedRef.current = countTouched; }, [countTouched]);
  const [reason, setReason] = useState<string>(ADJUST_REASONS[0]);
  const [note, setNote] = useState("");

  const load = async () => {
    const [{ data: p }, { data: c }, { data: s }, { data: b }] = await Promise.all([
      fetchAll((a, b) => supabase.from("products").select("*, categories(name), brands(name)").order("created_at", { ascending: false }).order("id").range(a, b)),
      supabase.from("categories").select("id, name"),
      supabase.from("subcategories").select("id, name, category_id"),
      supabase.from("brands").select("id, name"),
    ]);
    // In-stock products first, out-of-stock at the end; newest first within
    // each group (the order this table always used).
    setRows(inStockFirst(p ?? [], (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")));
    setCats(c ?? []); setSubs(s ?? []); setBrands(b ?? []);
  };
  useEffect(() => { load(); }, []);

  const startNew = (name = "") => {
    setEditing(null); setEditingName(""); setForm({ ...empty, product_name: name }); setOpeningStock("");
    setCurrentStock(0); setCounted(""); setCountTouched(false); setReason(ADJUST_REASONS[0]); setNote("");
  };

  // Matching ignores word order and looks at name, category and brand.
  // Sold-out products (hiddenFromBrowse) are left out while browsing unless
  // the toggle is on; a typed search always includes them, listed last
  // (rows are already in-stock first). Untracked services always show.
  // Deleted products appear only in the "Deleted products" view.
  const active = useMemo(() => rows.filter((r) => !isDeleted(r)), [rows]);
  const deleted = useMemo(() => rows.filter(isDeleted)
    .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? "")), [rows]);
  const hiddenCount = useMemo(() => active.filter(hiddenFromBrowse).length, [active]);
  const term = q.trim();
  const matches = (r: any) => matchesQuery(`${r.product_name ?? ""} ${r.categories?.name ?? ""} ${r.brands?.name ?? ""}`, term);
  const visible = useMemo(() => {
    if (showDeleted) return term ? deleted.filter(matches) : deleted;
    if (term) return active.filter(matches);
    return showOutOfStock ? active : active.filter((r) => !hiddenFromBrowse(r));
  }, [active, deleted, term, showOutOfStock, showDeleted]);
  const visibleOut = term && !showDeleted ? visible.filter(hiddenFromBrowse).length : 0;
  const deletedMatches = term && !showDeleted ? deleted.filter(matches).length : 0;

  // A product that already exists is opened instead of being entered twice;
  // a deleted one is brought back first.
  const openExisting = async (p: ProductRow) => {
    if (isDeleted(p)) {
      const { product, error } = await restoreProduct(p.id);
      if (error || !product) return toast.error(`"${p.product_name}" was deleted and could not be restored: ${error}`);
      toast.info(`"${p.product_name}" was deleted — restored it and opened it`, {
        description: "Its old sales and purchases are back with it. Fix its price or stock here and save.",
        duration: 8000,
      });
      load();
      return edit(product);
    }
    toast.info(`"${p.product_name}" already exists — opened it`, {
      description: "Fix its price or enter a counted stock here and save. New arrivals are booked on Stock Purchases.",
      duration: 8000,
    });
    edit(p);
  };

  const save = async () => {
    if (saving) return; // a double tap must not create the product twice
    setSaving(true);
    try { await persist(); } finally { setSaving(false); }
  };

  // The counted figure as a whole number; blank means "unchanged".
  const countedN = counted.trim() === "" ? currentStock : Math.round(Number(counted) || 0);
  const stockDelta = form.track_stock && countTouched ? countedN - currentStock : 0;

  const persist = async () => {
    const name = form.product_name.trim().replace(/\s+/g, " ");
    if (!name) return toast.error("Product name required");
    const payload = {
      product_name: name,
      description: form.description?.trim() || null,
      image_url: form.image_url || null,
      category_id: form.category_id || null,
      subcategory_id: form.subcategory_id || null,
      brand_id: form.brand_id || null,
      purchase_price: Number(form.purchase_price) || 0,
      // The shop price is whole rupees — no paisa figures on the shelf.
      selling_price: Math.round(Number(form.selling_price) || 0),
      track_stock: form.track_stock !== false,
      is_featured: !!form.is_featured,
      is_deal: !!form.is_deal,
      // A deal runs through the end of the chosen day (form holds YYYY-MM-DD).
      deal_end_date: form.is_deal && form.deal_end_date
        ? new Date(`${form.deal_end_date}T23:59:59`).toISOString() : null,
    };
    const describe = (e: { code?: string; message: string }) =>
      e.code === "23505" ? "A product with this name already exists" : e.message;

    if (editing) {
      if (stockDelta !== 0 && countedN < 0) return toast.error("Counted stock cannot be negative");
      // A rename may not land on another product's name (any spacing/case):
      // that would make two records for one product.
      if (normalizeProductName(name) !== normalizeProductName(editingName)) {
        const clash = await findProductByName(name).catch(() => null);
        if (clash && clash.id !== editing) {
          return toast.error(isDeleted(clash)
            ? `"${clash.product_name}" is a deleted product — restore it from Deleted products, or choose a different name`
            : `"${clash.product_name}" already exists — use that product, or choose a different name`);
        }
      }
      const { data, error } = await supabase.from("products").update(payload).eq("id", editing).select("id").maybeSingle();
      if (error) return toast.error(describe(error));
      if (!data) return toast.error("Product not found — refresh the page");
      if (form.track_stock && countTouched && counted.trim() !== "") {
        // The database books the difference to the LIVE ledger figure in one
        // statement, so a sale made since this page was opened cannot skew it.
        const { data: delta, error: adjErr } = await supabase.rpc("stock_set_count", {
          _product: editing, _counted: countedN, _reason: reason, _note: note.trim() || null,
        });
        if (adjErr) {
          // The product details are saved; refresh so a retry starts from them.
          await load();
          return toast.error(`Product saved, but the stock count failed: ${adjErr.message}`);
        }
        const d = Number(delta) || 0;
        toast.success(d === 0
          ? "Product updated — stock already matched the count"
          : `Product updated — stock ${d > 0 ? "+" : ""}${d} (${reason}), now ${countedN}`);
      } else {
        toast.success("Product updated");
      }
    } else {
      const opening = form.track_stock ? Math.round(Number(openingStock) || 0) : 0;
      if (opening < 0) return toast.error("Opening stock cannot be negative");
      // Re-entering a product that already exists — sold out and hidden, or
      // typed with different spacing/case — must not create a second record.
      // (If the lookup fails, the unique name index below is the backstop.)
      const existing = await findProductByName(name).catch(() => null);
      if (existing) return openExisting(existing);
      const { data, error } = await supabase.from("products").insert({ ...payload, quantity_in_stock: 0 }).select("id").maybeSingle();
      if (error) {
        if (error.code === "23505") {
          const again = await findProductByName(name).catch(() => null);
          if (again) return openExisting(again);
        }
        return toast.error(describe(error));
      }
      if (!data) return toast.error("Could not create product");
      // Right after adding: keep it, or delete it if it was a mistake.
      const keepOrDelete = (title: string) => toast.success(title, {
        description: `"${name}" — keep it, or delete it if it was added by mistake.`,
        duration: 15000,
        action: { label: "Delete", onClick: () => { remove({ ...payload, id: data.id }, { ask: false }); } },
        cancel: { label: "Keep", onClick: () => {} },
      });
      if (opening > 0) {
        const { error: adjErr } = await supabase.from("stock_adjustments").insert({
          product_id: data.id, delta: opening, reason: "Opening count", note: "Entered on the Products page",
        });
        // The product now exists, so a retry would hit the duplicate-name
        // check — close, and point at the edit dialog for the count.
        if (adjErr) toast.error(`Product created, but its opening stock was not saved — edit it and adjust the stock: ${adjErr.message}`);
        else keepOrDelete(`Product created with ${opening} in stock`);
      } else {
        keepOrDelete("Product created");
      }
    }
    setOpen(false); startNew(); load();
  };

  // Delete works for every product. One with no history at all is erased.
  // One with sales, purchases, quotations or amanat is marked deleted: its
  // old invoices, purchases, ledgers and reports keep showing it (erasing it
  // would blank the product on those rows, which the database refuses —
  // products_keep_history), but it leaves this list, the POS, every picker,
  // the stock figures and the website. Restore brings it back.
  const remove = async (r: any, { ask = true }: { ask?: boolean } = {}) => {
    const id: string = r.id;
    const name: string = r.product_name ?? "This product";
    const head = { count: "exact" as const, head: true };
    const [ii, sp, cp, qi, ai] = await Promise.all([
      supabase.from("invoice_items").select("id", head).eq("product_id", id),
      supabase.from("stock_purchases").select("id", head).eq("product_id", id),
      supabase.from("customer_purchases").select("id", head).eq("product_id", id),
      supabase.from("quotation_items").select("id", head).eq("product_id", id),
      supabase.from("amanat_items").select("id", head).eq("product_id", id),
    ]);
    const n = (res: { count: number | null }) => res.count ?? 0;
    // Sale lines and sales-history rows record the same sales.
    const sales = Math.max(n(ii), n(cp));
    const purchases = n(sp), quotes = n(qi), amanat = n(ai);
    const units = isTracked(r) ? stockOf(r) : 0;
    const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    const parts = [
      sales > 0 && plural(sales, "sale"),
      purchases > 0 && plural(purchases, "purchase"),
      quotes > 0 && plural(quotes, "quotation"),
      amanat > 0 && plural(amanat, "amanat entry", "amanat entries"),
    ].filter(Boolean).join(", ");

    const markDeleted = async () => {
      const { error } = await supabase.from("products").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) return false;
      toast.success(`"${name}" deleted`, {
        description: "Its sales and purchase records are kept. Restore it any time from Deleted products.",
        duration: 10000,
        action: { label: "Undo", onClick: () => { restore(r); } },
      });
      return true;
    };

    if (parts) {
      if (ask && !confirm(
        `Delete "${name}"?\n\nIt has ${parts}. Those records keep it: old invoices, purchases, ledgers and reports still show it.\n\n`
        + `It leaves the product list, POS, product pickers, stock figures and the website`
        + `${units > 0 ? ` — including the ${units} still counted in stock` : ""}.\n\nYou can restore it any time from "Deleted products".`)) return;
      if (!(await markDeleted())) return toast.error(`Could not delete "${name}" — check the connection and try again`);
    } else {
      if (ask && !confirm(units > 0
        ? `Delete "${name}" permanently? It has no sales or purchases; its stock count (${units}) is deleted with it.`
        : `Delete "${name}" permanently? It has no sales or purchase history.`)) return;
      const { error } = await supabase.from("products").delete().eq("id", id);
      if (error) {
        // History the counts above missed (e.g. a sale made just now): keep
        // the records and mark it deleted instead.
        if (error.code !== "P0001" || !(await markDeleted())) return toast.error(error.message, { duration: 8000 });
      } else {
        toast.success(`"${name}" deleted`);
      }
    }
    if (editing === id) { setOpen(false); startNew(); }
    load();
  };

  const restore = async (r: any) => {
    const { error } = await restoreProduct(r.id);
    if (error) return toast.error(`Could not restore "${r.product_name}": ${error}`);
    toast.success(`"${r.product_name}" restored`, { description: "It is back in the product list, POS and pickers." });
    load();
  };

  // Only the editable columns go into the form — never the embedded
  // categories/brands objects, id or created_at (PostgREST rejects them).
  const edit = (r: any) => {
    setEditing(r.id);
    setEditingName(r.product_name ?? "");
    setForm({
      product_name: r.product_name ?? "", description: r.description ?? "", image_url: r.image_url ?? "",
      category_id: r.category_id ?? "", subcategory_id: r.subcategory_id ?? "", brand_id: r.brand_id ?? "",
      purchase_price: r.purchase_price ?? 0, selling_price: r.selling_price ?? 0,
      track_stock: isTracked(r),
      is_featured: !!r.is_featured, is_deal: !!r.is_deal,
      // Keep the local calendar day in the form; the stored value is an instant.
      deal_end_date: r.deal_end_date ? (localDateOf(r.deal_end_date) || String(r.deal_end_date).slice(0, 10)) : "",
    });
    const stock = stockOf(r);
    setCurrentStock(stock); setCounted(String(stock)); setCountTouched(false); setReason(ADJUST_REASONS[0]); setNote("");
    setOpeningStock("");
    setOpen(true);
    // The list may be minutes old: show the live figure.
    supabase.from("products").select("quantity_in_stock").eq("id", r.id).maybeSingle().then(({ data }) => {
      if (!data) return;
      const live = stockOf(data);
      setCurrentStock(live);
      if (!countTouchedRef.current) setCounted(String(live));
    });
  };

  return (
    <AdminShell title="Products">
      {/* Search gets the full row with "Add product" beside it. */}
      <div className="flex gap-2 mb-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, category or brand… (any word order)" value={q}
                 onChange={(e) => setQ(e.target.value)} className="pl-9 pr-9 h-11 w-full" />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="h-11 shrink-0" onClick={() => startNew()}>
              <Plus className="h-4 w-4 mr-1.5" /> Add product
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editing ? "Edit" : "Add"} product</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Product name" full><Input value={form.product_name} onChange={(e) => setForm({ ...form, product_name: e.target.value })} /></Field>
              <Field label="Category">
                <SearchableSelect
                  options={cats.map((c) => ({ value: c.id, label: c.name }))}
                  value={form.category_id}
                  onValueChange={(v) => setForm({ ...form, category_id: v, subcategory_id: "" })}
                  placeholder="—" searchPlaceholder="Search category..."
                />
              </Field>
              <Field label="Subcategory">
                <SearchableSelect
                  options={subs.filter((s) => s.category_id === form.category_id).map((s) => ({ value: s.id, label: s.name }))}
                  value={form.subcategory_id}
                  onValueChange={(v) => setForm({ ...form, subcategory_id: v })}
                  placeholder="—" searchPlaceholder="Search subcategory..."
                />
              </Field>
              <Field label="Brand">
                <SearchableSelect
                  options={brands.map((b) => ({ value: b.id, label: b.name }))}
                  value={form.brand_id}
                  onValueChange={(v) => setForm({ ...form, brand_id: v })}
                  placeholder="—" searchPlaceholder="Search brand..."
                />
              </Field>
              <Field label="Product image" full><ImageUpload value={form.image_url} onChange={(url) => setForm({ ...form, image_url: url })} /></Field>
              <Field label="Purchase price — merchant cost (Rs)"><Input type="number" value={form.purchase_price} onChange={(e) => setForm({ ...form, purchase_price: e.target.value })} /></Field>
              <Field label="Selling price — shop price (Rs)"><Input type="number" step="1" value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} /></Field>
              <div className="col-span-2">
                <label className="flex items-start gap-2 cursor-pointer text-sm">
                  <Checkbox className="mt-0.5" checked={form.track_stock} onCheckedChange={(v) => setForm({ ...form, track_stock: v === true })} />
                  <span>Track stock — untick for services, trade-ins and consumables that are sold without being booked in</span>
                </label>
              </div>

              {!form.track_stock ? (
                <div className="col-span-2 text-xs text-muted-foreground rounded-lg bg-muted/40 px-3 py-2">
                  Not stock-tracked: always sellable, never shown as out of stock, no counts to keep.
                </div>
              ) : editing ? (
                <div className="col-span-2 rounded-xl border p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Current stock</div>
                      <div className="font-semibold">
                        {currentStock > 0 ? (
                          <span>{currentStock} in stock</span>
                        ) : (
                          <span className="text-destructive">
                            Out of stock{currentStock < 0 ? ` (${-currentStock} oversold — book the purchase)` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground max-w-xs">
                      Arrivals are booked on the Stock Purchases page and sales take units off automatically.
                      Use the count below only to correct what is on the shelf.
                    </div>
                  </div>
                  <div className="text-sm font-semibold">Adjust stock</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Counted stock">
                      <Input type="number" step="1" min="0" value={counted} onChange={(e) => { setCounted(e.target.value); setCountTouched(true); }} />
                    </Field>
                    <Field label="Reason">
                      <Select value={reason} onValueChange={setReason}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ADJUST_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Note (optional)" full>
                      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 tyres found damaged in the store room" />
                    </Field>
                  </div>
                  <div className="text-xs">
                    {stockDelta === 0
                      ? <span className="text-muted-foreground">No stock change.</span>
                      : <span className={stockDelta > 0 ? "text-green-600 font-semibold" : "text-destructive font-semibold"}>
                          Saving will record {stockDelta > 0 ? "+" : ""}{stockDelta} ({reason}) — stock becomes {countedN}.
                        </span>}
                  </div>
                </div>
              ) : (
                <Field label="Opening stock (units on the shelf now)">
                  <Input type="number" step="1" min="0" placeholder="0" value={openingStock} onChange={(e) => setOpeningStock(e.target.value)} />
                </Field>
              )}

              <Field label="Show on website" full>
                <div className="flex flex-wrap gap-5 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={!!form.is_featured} onCheckedChange={(v) => setForm({ ...form, is_featured: v === true })} /> Featured product
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox checked={!!form.is_deal} onCheckedChange={(v) => setForm({ ...form, is_deal: v === true })} /> Deal of the day
                  </label>
                </div>
              </Field>
              {form.is_deal && (
                <Field label="Deal ends on">
                  <Input type="date" value={form.deal_end_date || ""}
                         onChange={(e) => setForm({ ...form, deal_end_date: e.target.value })} />
                </Field>
              )}
              <Field label="Description" full><Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            </div>
            <div className="flex gap-2 mt-2">
              {editing && (
                <Button variant="outline" className="shrink-0 text-destructive hover:text-destructive" disabled={saving}
                        onClick={() => { const r = rows.find((x) => x.id === editing); if (r) remove(r); }}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                </Button>
              )}
              <Button className="flex-1" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {!showDeleted && (hiddenCount > 0 || showOutOfStock) && (
          <Button variant={showOutOfStock ? "secondary" : "outline"} size="sm" onClick={() => setShowOutOfStock((v) => !v)}
                  title="Browse out-of-stock products too (a search always finds them)">
            {showOutOfStock ? "Hide out of stock" : `Show out of stock (${hiddenCount})`}
          </Button>
        )}
        {(deleted.length > 0 || showDeleted) && (
          <Button variant={showDeleted ? "secondary" : "outline"} size="sm" onClick={() => setShowDeleted((v) => !v)}
                  title="Products you deleted — their sales and purchase records are kept; restore any you still sell">
            {showDeleted ? "Back to products" : `Deleted products (${deleted.length})`}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {showDeleted
            ? `${term ? `${visible.length} of ` : ""}${deleted.length} deleted product${deleted.length === 1 ? "" : "s"} · records kept · tap Restore to bring one back`
            : term
              ? `${visible.length} match${visible.length === 1 ? "" : "es"}${visibleOut > 0 ? ` · ${visibleOut} out of stock, listed last` : ""}${deletedMatches > 0 ? ` · ${deletedMatches} deleted (see Deleted products)` : ""}`
              : showOutOfStock
                ? `Showing all ${active.length} products${hiddenCount > 0 ? ` · ${hiddenCount} out of stock, listed last` : ""}`
                : `Showing ${visible.length} product${visible.length === 1 ? "" : "s"}${hiddenCount > 0 ? ` · ${hiddenCount} out of stock hidden` : ""}`}
        </span>
      </div>

      <div className="rounded-2xl bg-card shadow-sm overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Product</th><th className="p-3">Category</th><th className="p-3">Brand</th>
              <th className="p-3">Stock</th><th className="p-3">Price</th>
              {/* Actions stay pinned to the right edge, so Edit and Delete are
                  visible on a phone without scrolling the table sideways. */}
              <th className="p-3 sticky right-0 bg-muted"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3 font-medium">
                  <div className="flex items-center gap-3">
                    {r.image_url ? (
                      <img src={r.image_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover border" />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded bg-muted border" />
                    )}
                    <span>{r.product_name}</span>
                    {r.is_deal && <span className="ml-2 text-[10px] rounded-full bg-gold/15 text-amber-700 px-2 py-0.5 font-semibold">Deal</span>}
                    {r.is_featured && <span className="ml-1 text-[10px] rounded-full bg-primary/10 text-primary px-2 py-0.5 font-semibold">Featured</span>}
                    {isDeleted(r) && (
                      <span className="ml-1 whitespace-nowrap text-[10px] rounded-full bg-destructive/10 text-destructive px-2 py-0.5 font-semibold">
                        Deleted {shortDate(r.deleted_at)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-3 text-muted-foreground">{r.categories?.name ?? "—"}</td>
                <td className="p-3 text-muted-foreground">{r.brands?.name ?? "—"}</td>
                <td className="p-3">
                  {!isTracked(r) ? (
                    <span className="text-muted-foreground text-xs">Not tracked</span>
                  ) : stockOf(r) > 0 ? stockOf(r) : (
                    <span className="inline-block whitespace-nowrap text-[10px] rounded-full bg-destructive/10 text-destructive px-2 py-0.5 font-semibold">
                      Out of stock{stockOf(r) < 0 ? ` · ${-stockOf(r)} oversold` : ""}
                    </span>
                  )}
                </td>
                <td className="p-3 font-semibold">{money(r.selling_price)}</td>
                <td className="p-2 text-right whitespace-nowrap sticky right-0 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.15)]">
                  {isDeleted(r) ? (
                    <Button variant="outline" size="sm" onClick={() => restore(r)}>
                      <Undo2 className="h-4 w-4 mr-1.5" /> Restore
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" size="icon" title="Edit" aria-label={`Edit ${r.product_name}`} onClick={() => edit(r)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Delete" aria-label={`Delete ${r.product_name}`}
                              className="text-destructive hover:text-destructive" onClick={() => remove(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">
                {showDeleted ? (term ? `No deleted product matches “${term}”.` : "No deleted products.")
                  : active.length === 0 ? "No products yet." : q.trim() ? (
                  <div className="space-y-2">
                    <div>No product matches “{q.trim()}”.</div>
                    <Button variant="outline" size="sm" onClick={() => { startNew(q.trim().replace(/\s+/g, " ")); setOpen(true); }}>
                      <Plus className="h-4 w-4 mr-1" /> Add “{q.trim()}” as a new product
                    </Button>
                  </div>
                ) : "Every product is out of stock — tap “Show out of stock” or search by name."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`space-y-1.5 ${full ? "col-span-2" : ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
