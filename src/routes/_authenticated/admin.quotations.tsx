import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { printArea } from "@/lib/print";
import { money, shortDate, localToday } from "@/lib/format";
import { effectivePrice, inStockFirst } from "@/lib/pricing";
import { productOption } from "@/lib/stock";
import { confirmStockForSale } from "@/lib/products";
import { Letterhead } from "@/components/admin/Letterhead";
import { InvoiceQuickView } from "@/components/admin/InvoiceQuickView";
import { SearchableSelect } from "@/components/admin/SearchableSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, Printer, FileText, Search } from "lucide-react";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/_authenticated/admin/quotations")({
  component: QuotationsAdmin,
});

type QuoteLine = { product_id: string; product_name: string; quantity: number; unit_price: number };
const emptyLine = (): QuoteLine => ({ product_id: "", product_name: "", quantity: 1, unit_price: 0 });

const STATUSES = ["draft", "sent", "accepted", "converted"] as const;

function QuotationsAdmin() {
  const [rows, setRows] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [viewItems, setViewItems] = useState<any[]>([]);
  // Invoice slip shown right after a quotation is converted, as POS does.
  const [viewInvoice, setViewInvoice] = useState<string | null>(null);

  // builder state
  const [customerName, setCustomerName] = useState("");
  const [clientId, setClientId] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<QuoteLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [{ data: r }, { data: p }, { data: c }] = await Promise.all([
      supabase.from("quotations").select("*").order("created_at", { ascending: false }),
      fetchAll((a, b) => supabase.from("products").select("id, product_name, selling_price, purchase_price, quantity_in_stock, track_stock, deleted_at").order("id").range(a, b)),
      supabase.from("clients").select("id, name, account_no").order("name"),
    ]);
    setRows(r ?? []); setProducts(p ?? []); setClients(c ?? []);
  };
  useEffect(() => { load(); }, []);

  const setLine = (i: number, patch: Partial<QuoteLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const total = lines.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);

  const resetBuilder = () => {
    setCustomerName(""); setClientId(""); setValidUntil(""); setNotes("");
    setLines([emptyLine()]);
  };

  const save = async () => {
    if (!customerName.trim()) return toast.error("Customer name required");
    const valid = lines.filter((l) => l.product_name && Number(l.quantity) > 0);
    if (valid.length === 0) return toast.error("Add at least one item");
    if (lines.some((l) => !l.product_name && (Number(l.quantity) || 0) * (Number(l.unit_price) || 0) > 0))
      return toast.error("Pick or type an item name for every filled line");
    const validTotal = valid.reduce((a, l) => a + Number(l.quantity) * Number(l.unit_price), 0);

    setSaving(true);
    try {
      const { data: quote, error } = await supabase.from("quotations").insert({
        customer_name: customerName.trim(),
        client_id: clientId || null,
        valid_until: validUntil || null,
        notes: notes || null,
        total_amount: validTotal,
        status: "draft",
      }).select().maybeSingle();
      if (error) return toast.error(error.message);
      if (!quote) return toast.error("Could not create quotation");

      const { error: itemErr } = await supabase.from("quotation_items").insert(valid.map((l) => ({
        quotation_id: quote.id,
        product_id: l.product_id || null,
        product_name: l.product_name,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        total_price: Number(l.quantity) * Number(l.unit_price),
      })));
      if (itemErr) {
        await supabase.from("quotations").delete().eq("id", quote.id);
        return toast.error(itemErr.message);
      }

      toast.success(`Quotation ${quote.quote_no} created`);
      setBuilderOpen(false); resetBuilder(); load();
      view(quote);
    } finally {
      setSaving(false);
    }
  };

  const viewReq = useRef(0);
  const view = async (quote: any) => {
    setViewing(quote);
    setViewItems([]);
    const req = ++viewReq.current;
    const { data } = await supabase.from("quotation_items").select("*").eq("quotation_id", quote.id);
    if (req === viewReq.current) setViewItems(data ?? []);
  };

  const setStatus = async (status: string) => {
    if (!viewing) return;
    if (viewing.status === "converted" || status === "converted")
      return toast.error("Converted quotations cannot be changed manually");
    const { error } = await supabase.from("quotations").update({ status, updated_at: new Date().toISOString() }).eq("id", viewing.id);
    if (error) return toast.error(error.message);
    setViewing({ ...viewing, status });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this quotation?")) return;
    const { error } = await supabase.from("quotations").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted"); setViewing(null); load();
  };

  const convertToInvoice = async () => {
    if (!viewing || viewItems.length === 0) return toast.error("Nothing to convert");
    if (viewing.status === "converted") return toast.error("Already converted");
    if (viewItems.some((it) => it.quotation_id !== viewing.id))
      return toast.error("Items still loading — try again");
    if (!confirm(`Convert ${viewing.quote_no} into an invoice? Stock will be reduced for linked products.`)) return;
    // Live stock check on the linked products — selling past zero needs a yes.
    if (!(await confirmStockForSale(viewItems.map((it) => ({ product_id: it.product_id, qty: Number(it.quantity) }))))) return;

    // Claim the conversion atomically first so a double click or second
    // session can never create two invoices from the same quotation.
    const { data: claimed, error: claimErr } = await supabase.from("quotations")
      .update({ status: "converted", updated_at: new Date().toISOString() })
      .eq("id", viewing.id).neq("status", "converted").select();
    if (claimErr) return toast.error(claimErr.message);
    if (!claimed?.length) return toast.error("Already converted");

    const revertClaim = () =>
      supabase.from("quotations").update({ status: viewing.status, updated_at: new Date().toISOString() }).eq("id", viewing.id);

    const invId = "INV-" + Date.now();
    const { data: inv, error } = await supabase.from("invoices").insert({
      invoice_id: invId,
      customer_name: viewing.customer_name,
      total_amount: Number(viewing.total_amount),
      payment_method: "—",
      payment_status: "unpaid",
      client_id: viewing.client_id ?? null,
    }).select().maybeSingle();
    if (error || !inv) {
      await revertClaim();
      return toast.error(error?.message ?? "Could not create invoice");
    }

    const { error: itemsErr } = await supabase.from("invoice_items").insert(viewItems.map((it) => {
      const prod = products.find((p) => p.id === it.product_id);
      return {
        invoice_id: inv.id, product_id: it.product_id, product_name: it.product_name,
        quantity: it.quantity, unit_price: it.unit_price, total_price: it.total_price,
        cost_price: prod?.purchase_price ?? null,
      };
    }));
    if (itemsErr) {
      await supabase.from("invoices").delete().eq("id", inv.id);
      await revertClaim();
      return toast.error(itemsErr.message);
    }

    // Stock: the invoice_items trigger has already taken the linked
    // products' units off products.quantity_in_stock.

    if (viewing.client_id) {
      const { error: ledErr } = await supabase.from("client_ledger").insert({
        client_id: viewing.client_id, entry_type: "sale", amount: Number(viewing.total_amount),
        reference: invId, note: `From quotation ${viewing.quote_no}`, entry_date: localToday(),
      });
      if (ledErr) toast.error(`Invoice created but ledger entry failed: ${ledErr.message}`);
    }

    toast.success(`Invoice ${invId} created from ${viewing.quote_no}`);
    setViewing({ ...viewing, status: "converted" });
    setViewInvoice(invId);
    load();
  };

  const filtered = rows.filter((r) => !q ||
    [r.quote_no, r.customer_name].filter(Boolean).join(" ").toLowerCase().includes(q.toLowerCase()));

  return (
    <AdminShell title="Quotations">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by number or customer..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button onClick={() => setBuilderOpen(true)}><Plus className="h-4 w-4 mr-2" /> New quotation</Button>
      </div>

      <div className="rounded-2xl bg-card shadow-sm overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="p-3">Quote #</th><th className="p-3">Date</th><th className="p-3">Customer</th><th className="p-3">Total</th><th className="p-3">Valid until</th><th className="p-3">Status</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t hover:bg-muted/50 cursor-pointer" onClick={() => view(r)}>
                <td className="p-3 font-mono">{r.quote_no}</td>
                <td className="p-3">{shortDate(r.created_at)}</td>
                <td className="p-3">{r.customer_name}</td>
                <td className="p-3 font-semibold">{money(r.total_amount)}</td>
                <td className="p-3 text-muted-foreground">{r.valid_until ? shortDate(r.valid_until) : "—"}</td>
                <td className="p-3">
                  <span className={
                    r.status === "converted" ? "text-green-600" :
                    r.status === "accepted" ? "text-primary" :
                    r.status === "sent" ? "text-orange-500" : "text-muted-foreground"
                  }>{r.status}</span>
                </td>
                <td className="p-3"><Button variant="ghost" size="sm">View</Button></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">No quotations yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Builder */}
      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New quotation</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Customer name <span className="text-destructive">*</span></Label>
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
              <div className="space-y-1.5"><Label>Customer account (optional)</Label>
                <SearchableSelect
                  options={clients.map((c) => ({ value: c.id, label: `${c.account_no ? `${c.account_no} · ` : ""}${c.name}` }))}
                  value={clientId}
                  onValueChange={(v) => {
                    const c = clients.find((x) => x.id === v);
                    setClientId(v);
                    if (!customerName) setCustomerName(c?.name ?? "");
                  }}
                  placeholder="—" searchPlaceholder="Search by ID, name..."
                />
              </div>
              <div className="space-y-1.5"><Label>Valid until</Label>
                <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
              <div className="space-y-1.5"><Label>Notes (printed on quotation)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Prices valid while stock lasts" />
              </div>
            </div>

            <div className="rounded-xl border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label>Items</Label>
                <Button type="button" variant="ghost" size="sm" onClick={() => setLines([...lines, emptyLine()])}>
                  <Plus className="h-4 w-4 mr-1" /> Add item
                </Button>
              </div>
              {lines.map((l, i) => (
                <div key={i} className="space-y-2.5 rounded-xl border bg-muted/20 p-3">
                  <div className="flex gap-1.5 items-center">
                    <div className="flex-1 min-w-0">
                      <SearchableSelect
                        options={inStockFirst(products).map((p) => productOption(p, money(effectivePrice(p))))}
                        value={l.product_id}
                        onValueChange={(v) => {
                          const p = products.find((x) => x.id === v);
                          setLine(i, {
                            product_id: v, product_name: p?.product_name ?? "",
                            unit_price: effectivePrice(p),
                          });
                        }}
                        placeholder={l.product_name || "Product"}
                        searchPlaceholder="Search or type any item name..."
                        onCreate={(name) => setLine(i, { product_id: "", product_name: name, unit_price: 0 })}
                        createLabel="Use custom item"
                      />
                    </div>
                    {lines.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {l.product_name && !l.product_id && (
                    <div className="text-[11px] text-primary">Custom item: {l.product_name}</div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Quantity</Label>
                      <Input type="number" placeholder="Qty" value={l.quantity || ""} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Unit price (Rs)</Label>
                      <Input type="number" placeholder="0" value={l.unit_price || ""}
                        onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Line total</Label>
                      <div className="h-9 rounded-md border bg-muted/40 grid place-items-center text-sm font-bold">
                        {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex justify-between text-sm pt-1 border-t">
                <span className="text-muted-foreground">Total</span><b>{money(total)}</b>
              </div>
            </div>

            <Button className="w-full" onClick={save} disabled={saving}>
              {saving ? "Saving..." : `Create quotation (${money(total)})`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail / letterhead print */}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Quotation {viewing?.quote_no}</DialogTitle></DialogHeader>

          <div className="print-area text-sm">
            <Letterhead
              docTitle="Quotation"
              docNo={viewing?.quote_no ?? ""}
              date={viewing?.created_at}
              extra={viewing?.valid_until ? <div className="text-muted-foreground">Valid until {shortDate(viewing.valid_until)}</div> : undefined}
            />
            <div className="flex justify-between mb-3">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Quotation for</div>
                <div className="font-semibold">{viewing?.customer_name}</div>
              </div>
            </div>
            <table className="w-full border-t">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">#</th><th className="py-2">Item</th><th className="text-center">Qty</th><th className="text-right">Unit price</th><th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((it, i) => (
                  <tr key={it.id} className="border-t">
                    <td className="py-2 text-muted-foreground">{i + 1}</td>
                    <td className="py-2">{it.product_name}</td>
                    <td className="text-center">{it.quantity}</td>
                    <td className="text-right">{money(it.unit_price)}</td>
                    <td className="text-right font-medium">{money(it.total_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-between pt-3 border-t mt-2 font-bold text-base">
              <span>Grand total</span><span>{money(viewing?.total_amount)}</span>
            </div>
            {viewing?.notes && (
              <div className="mt-3 text-xs text-muted-foreground border-t pt-2">{viewing.notes}</div>
            )}
            <div className="mt-8 grid grid-cols-2 gap-8 text-xs text-muted-foreground">
              <div className="border-t pt-1">Prepared by</div>
              <div className="border-t pt-1">Customer signature</div>
            </div>
          </div>

          <div className="print:hidden flex flex-wrap gap-2 items-center pt-2 border-t">
            <Select value={viewing?.status ?? "draft"} onValueChange={setStatus} disabled={viewing?.status === "converted"}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.filter((s) => s !== "converted" || viewing?.status === "converted").map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => printArea()}><Printer className="h-4 w-4 mr-2" /> Print</Button>
            {viewing?.status !== "converted" && (
              <Button onClick={convertToInvoice}><FileText className="h-4 w-4 mr-2" /> Convert to invoice</Button>
            )}
            <Button variant="ghost" className="text-destructive ml-auto" onClick={() => remove(viewing.id)}>
              <Trash2 className="h-4 w-4 mr-2" /> Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <InvoiceQuickView invoiceRef={viewInvoice} onClose={() => setViewInvoice(null)} />
    </AdminShell>
  );
}
