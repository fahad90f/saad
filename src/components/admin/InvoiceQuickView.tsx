import { Children, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { printArea } from "@/lib/print";
import { money, shortDate } from "@/lib/format";
import { methodLabel } from "@/lib/payments";
import { toPaisa } from "@/lib/pricing";
import { useCompany } from "@/lib/company";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Printer, Wrench, MapPin, Phone, Mail, Globe, CircleDot, BatteryCharging,
  Droplet, LifeBuoy, Car, Sparkles, UserRound, Landmark, Award, Lock,
  CalendarDays, CheckCircle2, CreditCard, FileText,
} from "lucide-react";

const CATEGORIES = [
  { icon: CircleDot, label: "Tyres" },
  { icon: BatteryCharging, label: "Batteries" },
  { icon: Droplet, label: "Engine Oil" },
  { icon: LifeBuoy, label: "Alloy Rims" },
  { icon: Car, label: "Accessories" },
  { icon: Sparkles, label: "Car Care" },
];

export type InvoiceLoaded = { invoice: any; items: any[]; payments: any[]; client: any | null };

/**
 * The one invoice slip of the app — POS, the customer ledger, the Invoices
 * section and every clickable invoice reference open this same popup.
 * Looks the invoice up by its row id (`invoiceId`) when given, otherwise by
 * its human reference (INV-...). Always reads the live rows, so it shows the
 * current customer, items, payments and balance.
 * Styled as the black-and-gold company invoice; .print-keep makes the
 * printed copy keep the full design instead of flattening to plain text.
 *
 * `children` render under the slip, outside the printed area (admin actions
 * such as recording a payment). Bump `reloadKey` to refetch after a change.
 */
export function InvoiceQuickView({
  invoiceRef = null, invoiceId = null, reloadKey = 0, onClose, onLoaded, children,
}: {
  invoiceRef?: string | null;
  invoiceId?: string | null;
  reloadKey?: number;
  onClose: () => void;
  onLoaded?: (d: InvoiceLoaded) => void;
  children?: React.ReactNode;
}) {
  const [inv, setInv] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [client, setClient] = useState<any>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState(false);
  // Each product's current cost (internal block) and costs being typed for
  // lines saved without one; `refresh` refetches after a cost is saved.
  const [productCosts, setProductCosts] = useState<Record<string, number>>({});
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const COMPANY = useCompany();
  // Latest callback without re-running the loader when the parent passes an
  // inline function.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });
  // Which invoice the slip currently shows — a refetch of the same invoice
  // (reloadKey) keeps it on screen until the fresh rows arrive; a different
  // invoice clears it first so the old one never shows under the new title.
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    const key = invoiceId ? `id:${invoiceId}` : invoiceRef ? `ref:${invoiceRef}` : null;
    setNotFound(false);
    if (key !== shownKey.current) {
      setInv(null); setItems([]); setPayments([]); setClient(null); setImages({});
      shownKey.current = null;
    }
    if (!key) return;
    let cancelled = false;
    (async () => {
      const base = supabase.from("invoices").select("*");
      const { data: invoice } = await (invoiceId ? base.eq("id", invoiceId) : base.eq("invoice_id", invoiceRef!)).maybeSingle();
      if (cancelled) return;
      if (!invoice) {
        setInv(null); setItems([]); setPayments([]); setClient(null); setImages({});
        shownKey.current = null;
        setNotFound(true);
        return;
      }
      const [{ data: it }, { data: pays }, clientRes] = await Promise.all([
        supabase.from("invoice_items").select("*").eq("invoice_id", invoice.id).order("id"),
        supabase.from("invoice_payments").select("*").eq("invoice_id", invoice.id).order("payment_date").order("id"),
        invoice.client_id
          ? supabase.from("clients").select("id, name, account_no, current_balance, phone, address").eq("id", invoice.client_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (cancelled) return;
      const loaded: InvoiceLoaded = { invoice, items: it ?? [], payments: pays ?? [], client: clientRes.data ?? null };
      setInv(loaded.invoice); setItems(loaded.items); setPayments(loaded.payments); setClient(loaded.client);
      shownKey.current = key;
      onLoadedRef.current?.(loaded);
      // Product photos for the item rows (best effort — icon fallback).
      const pids = [...new Set(loaded.items.map((x: any) => x.product_id).filter(Boolean))] as string[];
      if (pids.length > 0) {
        const { data: prods } = await supabase.from("products").select("id, image_url, purchase_price").in("id", pids);
        if (cancelled) return;
        setImages(Object.fromEntries((prods ?? []).filter((p: any) => p.image_url).map((p: any) => [p.id, p.image_url])));
        setProductCosts(Object.fromEntries((prods ?? []).map((p: any) => [p.id, Number(p.purchase_price) || 0])));
      } else { setImages({}); setProductCosts({}); }
    })();
    return () => { cancelled = true; };
  }, [invoiceId, invoiceRef, reloadKey, refresh]);

  const open = !!(invoiceId || invoiceRef);
  const billName = client?.name ?? inv?.customer_name;

  const paid = payments.reduce((a, p) => a + Number(p.amount), 0);
  const balance = inv ? Math.max(0, Number(inv.total_amount) - paid) : 0;
  const cancelled = inv?.payment_status === "cancelled";
  const fullyPaid = !cancelled && balance <= 0 && Number(inv?.total_amount) > 0;
  // The account's standing before this bill, so the printed invoice shows
  // the complete position: previous balance + this bill = total outstanding.
  const accountTotal = client ? Number(client.current_balance) || 0 : 0;
  const previousBalance = client ? toPaisa(accountTotal - balance) : 0;
  // Internal figures (never printed): what the goods cost, and the margin —
  // over the lines whose cost is known. A line without a cost is listed for
  // the cost to be entered, never counted as all profit. Rs 1 stock-out lines
  // (stock manage, claims) are not sales and stay out, as in the P&L.
  const saleLines = items.filter((it) => Number(it.unit_price) > 1);
  const costed = saleLines.filter((it) => Number(it.cost_price) > 0);
  const uncosted = saleLines.filter((it) => !(Number(it.cost_price) > 0));
  const lineTotal = (it: any) => Number(it.total_price) || (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
  const costTotal = costed.reduce((a, it) => a + Number(it.cost_price) * (Number(it.quantity) || 0), 0);
  const costedSales = costed.reduce((a, it) => a + lineTotal(it), 0);
  const profit = toPaisa(costedSales - costTotal);

  // Record the cost of a line saved without one. A product with no cost on
  // record keeps it too, and its other sales without a cost take it as well
  // (database), so their profit corrects itself.
  const saveLineCost = async (it: any) => {
    const cost = Number(costDraft[it.id]);
    if (!(cost > 0)) return toast.error("Enter what one unit cost");
    const { error } = await supabase.from("invoice_items").update({ cost_price: cost }).eq("id", it.id);
    if (error) return toast.error(error.message);
    if (it.product_id && !(productCosts[it.product_id] > 0)) {
      const { error: pErr } = await supabase.from("products").update({ purchase_price: cost }).eq("id", it.product_id);
      if (pErr) toast.error(`Cost saved on this invoice, but not on the product: ${pErr.message}`);
      else toast.success(`${it.product_name}: cost ${money(cost)} saved — also on the product and its other sales without a cost`);
    } else {
      toast.success(`${it.product_name}: cost ${money(cost)} saved on this invoice`);
    }
    setCostDraft((d) => { const n = { ...d }; delete n[it.id]; return n; });
    setRefresh((k) => k + 1);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Invoice {inv?.invoice_id ?? invoiceRef ?? ""}</DialogTitle></DialogHeader>
        {notFound && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            {invoiceRef ? `No invoice found for reference ${invoiceRef}.` : "This invoice could not be found."}
          </div>
        )}
        {inv && (
          <div className="print-area print-keep print-one-page bg-white text-zinc-900 rounded-2xl overflow-hidden border border-zinc-200 text-sm print:text-xs">

            {/* ============ Black & gold letterhead ============ */}
            <div className="bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 text-white p-5 print:p-2.5 border-b-4 border-gold">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-14 w-14 print:h-11 print:w-11 shrink-0 rounded-xl bg-gold/15 border-2 border-gold/60 grid place-items-center text-gold">
                    <Wrench className="h-7 w-7 print:h-5 print:w-5" />
                  </div>
                  {/* Logo lockup — MT&B over HOUSE AUTO HUB, full name beneath. */}
                  <div className="leading-none min-w-0">
                    <div className="text-3xl print:text-2xl font-black tracking-[0.08em] text-gold">MT&B</div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="h-px w-5 bg-gold/70" />
                      <span className="text-[10px] print:text-[9px] font-bold uppercase tracking-[0.3em] text-amber-100">House Auto Hub</span>
                      <span className="h-px w-5 bg-gold/70" />
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.16em] text-zinc-300 mt-1.5">{COMPANY.fullName}</div>
                  </div>
                </div>
                <div className="text-[11px] print:text-[10px] leading-relaxed print:leading-snug shrink-0 space-y-1 print:space-y-0.5">
                  {[
                    { icon: MapPin, text: COMPANY.branch ? `${COMPANY.address} · ${COMPANY.branch} branch` : COMPANY.address },
                    { icon: Phone, text: COMPANY.phone },
                    { icon: Mail, text: COMPANY.email },
                    { icon: Globe, text: COMPANY.website },
                  ].map(({ icon: Icon, text }) => (
                    <div key={text} className="flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full border border-gold/60 grid place-items-center text-gold shrink-0">
                        <Icon className="h-3 w-3" />
                      </span>
                      <span className="text-zinc-200">{text}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4 print:mt-2 flex gap-2 flex-wrap">
                {CATEGORIES.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 rounded-lg border border-gold/40 bg-white/5 px-2 py-1 print:py-0.5 text-[9px] uppercase tracking-wider text-zinc-200">
                    <Icon className="h-3 w-3 text-gold" /> {label}
                  </span>
                ))}
              </div>
            </div>

            {/* ============ INVOICE title + number panel ============ */}
            <div className="flex items-start justify-between gap-4 px-5 pt-5 print:pt-2">
              <div>
                <div className="text-4xl print:text-2xl font-black tracking-tight">INVOICE</div>
                <div className="h-1 w-28 rounded-full bg-gradient-to-r from-gold to-amber-200 mt-1.5" />
              </div>
              <div className="bg-zinc-950 text-white rounded-xl border border-gold/50 px-4 py-2.5 print:py-1.5 text-right">
                <div className="text-[9px] uppercase tracking-[0.2em] text-gold">Invoice #</div>
                <div className="font-mono font-bold text-sm">{inv.invoice_id}</div>
                <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-gold/20 text-gold px-2 py-0.5 text-[11px] font-semibold">
                  <CalendarDays className="h-3 w-3" /> {shortDate(inv.created_at)}
                </div>
              </div>
            </div>

            {cancelled && (
              <div className="mx-5 mt-4 rounded-lg border-2 border-red-600 text-red-600 font-black text-center py-1.5 uppercase tracking-widest">
                Cancelled — items returned
              </div>
            )}

            {/* ============ Bill to + payment facts ============ */}
            {/* print:grid-cols-2 keeps the layout viewport-independent, so a
                phone measures the same height the A4 sheet will print. */}
            <div className="grid sm:grid-cols-2 print:grid-cols-2 gap-3 px-5 mt-4 print:mt-2 print-avoid-break">
              <div className="relative rounded-xl border-2 border-zinc-200 p-4 pt-6 print:p-3 print:pt-5">
                <div className="absolute top-0 left-0 bg-zinc-950 text-white text-[9px] font-bold px-3 py-1 rounded-br-lg rounded-tl-[10px] uppercase tracking-widest">Bill to</div>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-zinc-950 border-2 border-gold/60 grid place-items-center text-gold shrink-0">
                    <UserRound className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold truncate">{billName}</div>
                    {client?.account_no
                      ? <div className="text-[11px] text-zinc-500">Account {client.account_no}</div>
                      : billName !== "Walk-in customer"
                        ? <div className="text-[11px] text-zinc-500">Walk-in customer</div>
                        : <div className="mt-1 border-b border-dashed border-zinc-300 w-28" />}
                    {client?.phone && (
                      <div className="text-[11px] text-zinc-500 flex items-center gap-1 mt-0.5">
                        <Phone className="h-3 w-3 shrink-0 text-amber-600" /> {client.phone}
                      </div>
                    )}
                    {client?.address && (
                      <div className="text-[11px] text-zinc-500 flex items-start gap-1 mt-0.5 break-words">
                        <MapPin className="h-3 w-3 shrink-0 mt-0.5 text-amber-600" /> <span className="min-w-0">{client.address}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-xl border-2 border-zinc-200 p-4 print:p-3 grid grid-cols-2 gap-x-3 gap-y-3 print:gap-y-1.5">
                <Fact icon={CheckCircle2} label="Payment status">
                  <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-black uppercase text-white ${
                    cancelled ? "bg-red-600" : fullyPaid ? "bg-green-600" : paid > 0 ? "bg-amber-500" : "bg-zinc-500"}`}>
                    {cancelled ? "Cancelled" : fullyPaid ? "Paid ✓" : paid > 0 ? "Partial" : "Unpaid"}
                  </span>
                </Fact>
                <Fact icon={CreditCard} label="Payment method">{inv.payment_method || "—"}</Fact>
                <Fact icon={CalendarDays} label="Date">{shortDate(inv.created_at)}</Fact>
                <Fact icon={FileText} label="Due date">
                  {inv.due_date && balance > 0
                    ? <span className="text-orange-500 font-semibold">{shortDate(inv.due_date)}</span>
                    : "—"}
                </Fact>
              </div>
            </div>

            {/* ============ Items ============ */}
            <div className="px-5 mt-4 print:mt-2">
              <div className="rounded-xl overflow-hidden border border-zinc-200">
                <table className="w-full">
                  <thead className="bg-zinc-950">
                    <tr className="text-left text-[10px] uppercase tracking-wider text-gold">
                      <th className="py-2.5 print:py-1 px-3 font-bold">Item</th>
                      <th className="py-2.5 print:py-1 px-2 font-bold">Description</th>
                      <th className="py-2.5 print:py-1 px-2 text-center font-bold">Qty</th>
                      <th className="py-2.5 print:py-1 px-2 text-right font-bold">Unit price</th>
                      <th className="py-2.5 print:py-1 px-3 text-right font-bold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={it.id} className={`border-t border-zinc-100 ${i % 2 ? "bg-zinc-50" : "bg-white"}`}>
                        <td className="py-2 print:py-0.5 px-3 w-12">
                          {it.product_id && images[it.product_id]
                            ? <img src={images[it.product_id]} alt="" className="h-9 w-9 print:h-5 print:w-5 rounded-lg object-cover border border-zinc-200" />
                            : <span className="h-9 w-9 print:h-5 print:w-5 rounded-lg bg-zinc-950 grid place-items-center text-gold"><CircleDot className="h-4 w-4" /></span>}
                        </td>
                        <td className="py-2 print:py-0.5 px-2 font-semibold">{it.product_name}</td>
                        <td className="py-2 print:py-0.5 px-2 text-center font-bold">{it.quantity}</td>
                        <td className="py-2 print:py-0.5 px-2 text-right">{money(it.unit_price)}</td>
                        <td className="py-2 print:py-0.5 px-3 text-right font-bold">{money(it.total_price)}</td>
                      </tr>
                    ))}
                    {items.length === 0 && (
                      <tr><td colSpan={5} className="py-5 text-center text-zinc-400">No item details on this invoice.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ============ Quality mark + grand total ============ */}
            <div className="px-5 mt-4 print:mt-2 flex items-center justify-between gap-4 flex-wrap print-avoid-break">
              <div className="flex items-center gap-3">
                <div className="h-16 w-16 print:h-10 print:w-10 rounded-full border-[3px] border-gold bg-zinc-950 grid place-items-center text-gold shrink-0">
                  <Award className="h-8 w-8 print:h-5 print:w-5" />
                </div>
                <div className="leading-tight">
                  <div className="text-[11px] font-black uppercase tracking-widest text-amber-600">Quality</div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">you can trust</div>
                </div>
              </div>
              <div className="bg-zinc-950 text-white rounded-2xl border-2 border-gold/70 px-6 py-4 print:py-2 text-right min-w-[220px]">
                <div className="text-[10px] uppercase tracking-[0.25em] text-gold">Grand total</div>
                <div className="text-3xl print:text-xl font-black mt-0.5">{money(inv.total_amount)}</div>
                <div className="h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent my-2 print:my-1" />
                {cancelled ? (
                  <span className="inline-block rounded-md bg-red-600 px-3 py-0.5 text-[11px] font-black uppercase">Cancelled</span>
                ) : fullyPaid ? (
                  <span className="inline-block rounded-md bg-green-600 px-3 py-0.5 text-[11px] font-black uppercase">Paid ✓</span>
                ) : (
                  <span className="inline-block rounded-md bg-amber-500 px-3 py-0.5 text-[11px] font-black uppercase">
                    Balance due {money(balance)}
                  </span>
                )}
              </div>
            </div>

            {/* ============ Payment accounts (set in Business Settings) ============ */}
            {(COMPANY.bankAccountNumber || COMPANY.jazzcashNumber) && (
              <div className="mx-5 mt-4 print:mt-1.5 rounded-xl border-2 border-gold/50 bg-amber-50 px-3 py-2 print:py-1 flex flex-wrap items-center gap-x-5 gap-y-1 print-avoid-break">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-amber-700">
                  <Landmark className="h-3 w-3" /> Pay by transfer
                </div>
                {COMPANY.jazzcashNumber && (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="text-[10px] uppercase tracking-wider text-amber-700 font-bold">JazzCash</span>
                    <span className="font-mono font-black text-sm tracking-wide">{COMPANY.jazzcashNumber}</span>
                    {COMPANY.jazzcashTitle && <span className="text-zinc-600">{COMPANY.jazzcashTitle}</span>}
                  </div>
                )}
                {COMPANY.bankAccountNumber && (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="text-[10px] uppercase tracking-wider text-amber-700 font-bold">{COMPANY.bankName || "Bank"}</span>
                    <span className="font-mono font-black text-sm tracking-wide">{COMPANY.bankAccountNumber}</span>
                    {COMPANY.bankAccountTitle && <span className="text-zinc-600">{COMPANY.bankAccountTitle}</span>}
                    {COMPANY.bankIban && <span className="text-zinc-500 font-mono text-[11px]">IBAN {COMPANY.bankIban}</span>}
                  </div>
                )}
              </div>
            )}

            {/* ============ Payments ============ */}
            <div className="px-5 mt-4 print:mt-2">
              <div className="inline-block text-[11px] font-black uppercase tracking-[0.2em] text-amber-600 border-b-2 border-gold/60 pb-0.5 mb-2 print:mb-1">
                Payments
              </div>
              {payments.length === 0 ? (
                <div className="text-xs text-zinc-400">No payments recorded yet.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5 print:gap-1">
                  {payments.map((p) => (
                    <div key={p.id} className="inline-flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 print:py-0.5">
                      <div className="flex items-center gap-2 text-xs text-zinc-600">
                        <Landmark className="h-3.5 w-3.5 text-zinc-500" />
                        {shortDate(p.payment_date)} — {methodLabel(p.method)}
                      </div>
                      <div className="text-xs font-bold text-green-600">{money(p.amount)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ============ Account summary (khaata customers) ============ */}
            {client && (
              <div className="mx-5 mt-4 print:mt-2 rounded-xl border border-zinc-200 p-4 print:p-2.5 space-y-1 print:space-y-0.5 print-avoid-break">
                <div className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-600 mb-1">
                  Account summary — {client.name}
                </div>
                <div className="flex justify-between text-zinc-500 text-xs">
                  <span>Previous balance (other bills)</span><span className="text-zinc-900 font-semibold">{money(previousBalance)}</span>
                </div>
                <div className="flex justify-between text-zinc-500 text-xs">
                  <span>This invoice balance</span><span className="text-zinc-900 font-semibold">{money(balance)}</span>
                </div>
                <div className="flex justify-between font-black text-sm border-t border-zinc-200 pt-1.5 mt-1">
                  <span>Total outstanding</span>
                  <span className={accountTotal > 0 ? "text-orange-500" : "text-green-600"}>{money(accountTotal)}</span>
                </div>
              </div>
            )}

            {/* ============ Internal cost & profit — never printed ============ */}
            {saleLines.length > 0 && (
              <div className="mx-5 mt-4 rounded-xl border border-gold/50 bg-amber-50 p-4 print:hidden">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-amber-700 mb-1.5">
                  <Lock className="h-3 w-3" /> Internal — hidden from customer
                </div>
                {/* Line by line: sold at, cost each, profit. */}
                <div className="space-y-1 mb-2">
                  {saleLines.map((it) => {
                    const qty = Number(it.quantity) || 0;
                    const cost = Number(it.cost_price) > 0 ? Number(it.cost_price) : null;
                    const lp = cost == null ? null : toPaisa(lineTotal(it) - cost * qty);
                    return (
                      <div key={it.id} className="text-xs text-zinc-600 flex items-center justify-between gap-2 flex-wrap">
                        <span className="min-w-0 truncate">
                          {it.product_name} × {qty} · sold {money(Number(it.unit_price) || 0)}
                          {cost != null && <> · cost {money(cost)}</>}
                        </span>
                        {cost != null ? (
                          <span className={`font-semibold ${lp! >= 0 ? "text-green-600" : "text-red-600"}`}>{money(lp!)}</span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <span className="text-orange-600 font-semibold">No cost</span>
                            <Input type="number" placeholder="Cost each" className="h-7 w-24 text-xs bg-white"
                                   value={costDraft[it.id] ?? ""} onChange={(e) => setCostDraft((d) => ({ ...d, [it.id]: e.target.value }))} />
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => saveLineCost(it)}>Save</Button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-zinc-600 border-t border-amber-200 pt-1.5">
                  <span>Cost (purchase price)</span><span className="font-semibold text-zinc-900">{money(costTotal)}</span>
                </div>
                <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
                  <span>Profit{uncosted.length > 0 ? " (items with a cost)" : ""}</span>
                  <span className={`font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {money(profit)}{costedSales > 0 ? ` (${Math.round((profit / costedSales) * 100)}%)` : ""}
                  </span>
                </div>
                {uncosted.length > 0 && (
                  <div className="text-[11px] text-orange-700 mt-1">
                    {uncosted.length} item{uncosted.length === 1 ? " has" : "s have"} no cost recorded — enter what one unit cost above to include {uncosted.length === 1 ? "it" : "them"} in the profit.
                  </div>
                )}
              </div>
            )}

            {/* ============ Thank you + print ============ */}
            <div className="px-5 mt-4 print:mt-2 mb-4 print:mb-2 flex items-center justify-between gap-3 flex-wrap">
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 print:py-1 leading-tight">
                <div className="font-serif italic font-bold text-base print:text-sm">Thank you!</div>
                <div className="text-[11px] text-zinc-500">
                  For choosing <span className="text-amber-600 font-semibold">{COMPANY.name}</span>
                </div>
              </div>
              <Button className="bg-zinc-950 hover:bg-zinc-800 text-white print:hidden" onClick={() => printArea()}>
                <Printer className="h-4 w-4 mr-2" /> Print Invoice
              </Button>
            </div>

            {/* ============ Footer ============ */}
            <div className="bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 border-t-4 border-gold text-center py-3 print:py-1 px-4">
              <div className="font-serif italic text-gold text-sm print:text-xs">Driven by Quality · Trusted by You</div>
              <div className="text-[9px] uppercase tracking-[0.3em] text-zinc-400 mt-0.5">Your trust is our drive</div>
            </div>
          </div>
        )}
        {/* Admin actions from the opening screen — never part of the slip. */}
        {inv && Children.toArray(children).length > 0 && <div className="print:hidden space-y-2">{children}</div>}
      </DialogContent>
    </Dialog>
  );
}

// Invoice numbers: INV-<timestamp> (this app) and INV<hex> (imported history).
const INVOICE_REF = /^INV-?[A-Za-z0-9]+$/;

/**
 * An invoice number that opens the slip when clicked. Anything that doesn't
 * look like an invoice number (free-text references) stays plain text unless
 * `known` says it is one. Prints as plain text inside reports.
 */
export function InvoiceRefLink({ value, onOpen, known = false }: {
  value: string;
  onOpen: (ref: string) => void;
  known?: boolean;
}) {
  if (!known && !INVOICE_REF.test(value.trim())) return <>{value}</>;
  return (
    <button
      type="button"
      title={`Open invoice ${value}`}
      onClick={(e) => { e.stopPropagation(); onOpen(value.trim()); }}
      className="font-mono text-primary underline-offset-2 hover:underline print:text-inherit print:no-underline"
    >
      {value}
    </button>
  );
}

function Fact({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="h-7 w-7 rounded-lg bg-zinc-950 grid place-items-center text-gold shrink-0">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="text-xs font-semibold mt-0.5 break-words leading-snug">{children}</div>
      </div>
    </div>
  );
}
