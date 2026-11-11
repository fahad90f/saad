import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, localToday, localDateOf, shortDate } from "@/lib/format";
import { isTracked, stockOf, oversold } from "@/lib/stock";
import { normalizeProductName } from "@/lib/pricing";
import { loadMonthPnL, monthLabel, type MonthPnL } from "@/lib/finance";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from "recharts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/_authenticated/admin/reports")({
  component: Reports,
});

/** "2026-07" for a Date, in the device's local time (never UTC). */
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthName = monthLabel;

/** Out-of-stock items are only worth reordering if they still sell. */
const RECENT_DAYS = 60;

/** Rs 1 lines ring stock out (stock manage / claim clear); they are not sales. */
const isStockOutRow = (s: { total_price?: number | null; quantity_purchased?: number | null }) => {
  const qty = Number(s.quantity_purchased) || 0;
  return qty !== 0 && Number(s.total_price) / qty <= 1;
};

const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
/** An amount taken off in the statement: "− Rs 1,200" (plain "Rs 0" when nothing). */
const minus = (n: number) => (n ? `− ${money(n)}` : money(0));
/** Signed amount; `|| 0` so a rounded −0 never prints as "Rs -0". */
const signed = (n: number) => money(n || 0);

function Reports() {
  const [month, setMonth] = useState(localToday().slice(0, 7));
  const [sales, setSales] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [ledgerPays, setLedgerPays] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<any[]>([]);
  const [pnl, setPnl] = useState<MonthPnL | null>(null);
  const [pnlError, setPnlError] = useState<string | null>(null);

  useEffect(() => {
    const now = new Date();
    const recentFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - RECENT_DAYS).toISOString();
    (async () => {
      const [{ data: s }, { data: ip }, { data: lp }, { data: ex }, { data: p }, { data: ri }] = await Promise.all([
        fetchAll((a, b) => supabase.from("customer_purchases").select("*, products(product_name)").order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("invoice_payments").select("id, amount, method, payment_date, invoices(client_id)").order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("client_ledger").select("id, amount, method, entry_date, reference").eq("entry_type", "payment").order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("expenses").select("id, amount, date_of_expense").order("id").range(a, b)),
        // Reorder list: products the shop still carries (not deleted).
        fetchAll((a, b) => supabase.from("products").select("id, product_name, quantity_in_stock, track_stock").is("deleted_at", null).order("id").range(a, b)),
        // Every sale (POS, khaata, quotations) is an invoice; returns shrink
        // its lines in place, so this is what actually sold recently.
        fetchAll((a, b) => supabase.from("invoices")
          .select("id, created_at, payment_status, invoice_items(product_id, quantity, unit_price)")
          .gte("created_at", recentFrom)
          .or("payment_status.is.null,payment_status.neq.cancelled")
          .order("id").range(a, b)),
      ]);
      setSales(s ?? []); setPayments(ip ?? []); setLedgerPays(lp ?? []);
      setExpenses(ex ?? []); setProducts(p ?? []); setRecentInvoices(ri ?? []);
    })();
  }, []);

  // Profit & loss for the selected month (same figures as the dashboard).
  useEffect(() => {
    let live = true;
    setPnl(null); setPnlError(null);
    loadMonthPnL(month)
      .then((r) => { if (live) setPnl(r); })
      .catch((e) => { if (live) setPnlError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [month]);

  // Recovered, one row per real payment: walk-in bills settle through
  // invoice_payments; account customers settle through their ledger (their
  // invoice_payments rows are only allocation records) — same rule as the
  // daily closing, so an allocated khaata payment is never counted twice.
  const allRecovered = useMemo(() => [
    ...payments
      .filter((p: any) => !p.invoices?.client_id)
      .map((p) => ({ amount: Number(p.amount), date: p.payment_date as string, method: p.method as string })),
    ...ledgerPays
      .map((l) => ({ amount: Number(l.amount), date: l.entry_date as string, method: (l.method ?? "cash") as string })),
  ], [payments, ledgerPays]);

  const monthOptions = useMemo(() => {
    const opts: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) opts.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 15)));
    return opts;
  }, []);

  const mSales = sales.filter((s) => (s.purchase_date ?? "").startsWith(month));
  const mRecovered = allRecovered.filter((r) => (r.date ?? "").startsWith(month));
  const mExpenses = expenses.filter((e) => (e.date_of_expense ?? "").startsWith(month));

  // Cash view: money actually received vs money paid out (refunds included).
  const totalRecovered = mRecovered.reduce((a, r) => a + r.amount, 0);
  const cashExpenses = mExpenses.reduce((a, e) => a + Number(e.amount), 0);
  const netCash = totalRecovered - cashExpenses;

  // Daily series for the selected month
  const daily = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const days = new Date(y, m, 0).getDate();
    return Array.from({ length: days }, (_, i) => {
      const key = `${month}-${String(i + 1).padStart(2, "0")}`;
      return {
        day: String(i + 1),
        sales: mSales.filter((s) => s.purchase_date === key).reduce((a, s) => a + Number(s.total_price), 0),
        recovered: mRecovered.filter((r) => r.date === key).reduce((a, r) => a + r.amount, 0),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, sales, allRecovered]);

  // 12-month trend
  const monthly = useMemo(() => monthOptions.slice().reverse().map((key) => ({
    month: monthName(key),
    sales: sales.filter((s) => (s.purchase_date ?? "").startsWith(key)).reduce((a, s) => a + Number(s.total_price), 0),
    recovered: allRecovered.filter((r) => (r.date ?? "").startsWith(key)).reduce((a, r) => a + r.amount, 0),
  })), [monthOptions, sales, allRecovered]);

  const bySales: Record<string, number> = {};
  mSales.filter((s) => !isStockOutRow(s)).forEach((s) => {
    const n = s.products?.product_name ?? "—";
    bySales[n] = (bySales[n] ?? 0) + Number(s.quantity_purchased || 0);
  });
  const most = Object.entries(bySales).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty }));

  // Out of stock, but only what still sells: tracked products at or below
  // zero that sold in the last RECENT_DAYS days. (Services and trade-ins are
  // not stock-tracked, so they can't be out of stock.) Duplicate-name copies
  // of one product (until they are merged) count as one: a name that still
  // has stock on any tracked copy is not out of stock, and the sold-out
  // copies of one name make a single row with their sales added up.
  const recentSold = useMemo(() => {
    const map = new Map<string, { units: number; last: string }>();
    for (const inv of recentInvoices) {
      const day = localDateOf(inv.created_at);
      for (const it of (inv.invoice_items ?? []) as any[]) {
        const qty = Number(it.quantity) || 0;
        if (!it.product_id || qty <= 0 || Number(it.unit_price) <= 1) continue;
        const cur = map.get(it.product_id);
        map.set(it.product_id, { units: (cur?.units ?? 0) + qty, last: cur && cur.last > day ? cur.last : day });
      }
    }
    return map;
  }, [recentInvoices]);
  const { reorder, otherOut } = useMemo(() => {
    const nameKey = (p: any) => normalizeProductName(p.product_name) || `id:${p.id}`;
    const stockedNames = new Set(products.filter((p) => isTracked(p) && stockOf(p) > 0).map(nameKey));
    type OutRow = { key: string; product_name: string; oversoldUnits: number; sold: { units: number; last: string } | null };
    const byName = new Map<string, OutRow>();
    for (const p of products) {
      if (!isTracked(p) || stockOf(p) > 0) continue;
      const key = nameKey(p);
      if (stockedNames.has(key)) continue;
      const row = byName.get(key) ?? { key, product_name: p.product_name ?? "—", oversoldUnits: 0, sold: null };
      row.oversoldUnits += oversold(p);
      const s = recentSold.get(p.id);
      if (s) row.sold = { units: (row.sold?.units ?? 0) + s.units, last: row.sold && row.sold.last > s.last ? row.sold.last : s.last };
      byName.set(key, row);
    }
    const out = [...byName.values()];
    const reorder = out
      .flatMap((r) => (r.sold ? [{ ...r, sold: r.sold }] : []))
      .sort((a, b) => b.sold.units - a.sold.units || b.sold.last.localeCompare(a.sold.last));
    return { reorder, otherOut: out.length - reorder.length };
  }, [products, recentSold]);

  const netLabel = pnl && pnl.netProfit < 0 ? "Net loss" : "Net profit";

  return (
    <AdminShell title="Monthly Reports">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-muted-foreground">Report month:</div>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthOptions.map((m) => <SelectItem key={m} value={m}>{monthName(m)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 mb-6">
        <Kpi label="Sales" v={pnl ? signed(pnl.revenue) : "…"} sub="billed, net of returns" />
        <Kpi label="Gross profit" v={pnl ? signed(pnl.grossProfit) : "…"} sub={pnl ? `margin ${pct(pnl.grossMargin)}` : undefined}
             green={!!pnl && pnl.grossProfit >= 0} accent={!!pnl && pnl.grossProfit < 0} />
        <Kpi label="Expenses" v={pnl ? money(pnl.expenses) : "…"} />
        <Kpi label={netLabel} v={pnl ? signed(pnl.netProfit) : "…"}
             green={!!pnl && pnl.netProfit >= 0} accent={!!pnl && pnl.netProfit < 0} />
        <Kpi label="Total loss" v={pnl ? money(pnl.totalLoss) : "…"} accent={!!pnl && pnl.totalLoss > 0} />
        <Kpi label="Payments recovered" v={money(totalRecovered)} sub="cash received" green />
        <Kpi label="Orders" v={pnl ? String(pnl.invoiceCount) : "…"} sub="invoices" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="lg:col-span-2">
          <PnlCard month={month} pnl={pnl} error={pnlError} />
        </div>
        <Card title={`Sales trend — ${monthName(month)} (daily)`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="day" fontSize={10} interval={2} />
              <YAxis fontSize={11} />
              <Tooltip formatter={(v: any) => money(v)} />
              <Bar dataKey="sales" name="Sales" fill="#2563EB" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title={`Payment collection — ${monthName(month)} (daily)`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="day" fontSize={10} interval={2} />
              <YAxis fontSize={11} />
              <Tooltip formatter={(v: any) => money(v)} />
              <Bar dataKey="recovered" name="Recovered" fill="#10B981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Sales vs recovery — last 12 months">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={monthly}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="month" fontSize={10} />
              <YAxis fontSize={11} />
              <Tooltip formatter={(v: any) => money(v)} />
              <Legend />
              <Line type="monotone" dataKey="sales" name="Sales" stroke="#2563EB" strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="recovered" name="Recovered" stroke="#10B981" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title={`Most sold — ${monthName(month)}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={most}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="name" fontSize={10} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Bar dataKey="qty" name="Units" fill="#F59E0B" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Sold recently, now out of stock — reorder">
          <ul className="text-sm space-y-1 max-h-64 overflow-y-auto">
            {reorder.length === 0 ? <li className="text-muted-foreground">Nothing sold in the last {RECENT_DAYS} days is out of stock.</li> :
              reorder.map((p) => (
                <li key={p.key} className="flex justify-between gap-3 border-b py-1">
                  <span className="min-w-0">
                    <span className="block truncate">{p.product_name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.sold.units} sold in {RECENT_DAYS} days · last {shortDate(`${p.sold.last}T00:00:00`)}
                    </span>
                  </span>
                  <span className="text-destructive shrink-0">Out of stock{p.oversoldUnits > 0 && ` · ${p.oversoldUnits} oversold`}</span>
                </li>
              ))}
          </ul>
          {otherOut > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {otherOut} other out-of-stock product{otherOut === 1 ? "" : "s"} not sold in the last {RECENT_DAYS} days {otherOut === 1 ? "is" : "are"} not listed.
            </p>
          )}
        </Card>
        <Card title={`Cash — ${monthName(month)}`}>
          <ul className="text-sm space-y-2">
            <li className="flex justify-between border-b pb-2"><span>Payments recovered (cash in)</span><b className="text-green-600">{money(totalRecovered)}</b></li>
            <li className="flex justify-between border-b pb-2"><span>Expenses paid, incl. refunds (cash out)</span><b className="text-orange-500">{money(cashExpenses)}</b></li>
            <li className="flex justify-between"><span>Net cash (recovered − expenses)</span><b className={netCash >= 0 ? "text-green-600" : "text-destructive"}>{money(netCash)}</b></li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Cash only — money received and paid out this month, whatever month the sale was made. For profit, see Profit &amp; loss above.
          </p>
        </Card>
      </div>
    </AdminShell>
  );
}

function PnlCard({ month, pnl, error }: { month: string; pnl: MonthPnL | null; error: string | null }) {
  const title = `Profit & loss — ${monthName(month)}`;
  if (error) return <Card title={title}><div className="text-sm text-destructive">Could not calculate: {error}</div></Card>;
  if (!pnl) return <Card title={title}><div className="text-sm text-muted-foreground">Calculating…</div></Card>;

  const topTypes = pnl.expensesByType.slice(0, 6);
  const restTypes = pnl.expensesByType.slice(6);
  const restSum = restTypes.reduce((a, t) => a + t.amount, 0);
  const loss = pnl.netProfit < 0;

  return (
    <Card title={title}>
      <div className="grid md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <ul className="space-y-2">
          <Line2 label="Sales" hint="billed, net of returns" v={signed(pnl.revenue)} />
          <Line2 label="Cost of goods" hint="cost price of what was sold" v={minus(pnl.cogs)} />
          <Line2
            label="Gross profit" hint={`margin ${pct(pnl.grossMargin)}`} v={signed(pnl.grossProfit)} strong
            tone={pnl.grossProfit >= 0 ? "good" : "bad"}
          />
          <Line2 label="Expenses" hint="running costs" v={minus(pnl.expenses)} />
          <Line2 label="Stock written off" hint="damaged or expired, at purchase price" v={minus(pnl.writeOffs)} />
          <li className="flex justify-between items-baseline border-t-2 pt-2">
            <span className="font-semibold">{loss ? "Net loss" : "Net profit"}</span>
            <b className={`text-lg ${loss ? "text-destructive" : "text-green-600"}`}>{signed(pnl.netProfit)}</b>
          </li>
          <li className="flex justify-between items-baseline border-t pt-2">
            <span>
              <span className="font-semibold">Total loss</span>
              <span className="block text-xs text-muted-foreground">
                Sales below cost {money(pnl.belowCostLoss)} · Stock written off {money(pnl.writeOffs)} · Other loss {money(pnl.otherLoss)}
              </span>
            </span>
            <b className={pnl.totalLoss > 0 ? "text-destructive" : ""}>{money(pnl.totalLoss)}</b>
          </li>
        </ul>

        <div className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Expenses by type</div>
            {pnl.expensesByType.length === 0 ? (
              <div className="text-muted-foreground">No expenses recorded.</div>
            ) : (
              <ul className="space-y-1">
                {topTypes.map((t) => (
                  <li key={t.type} className="flex justify-between border-b pb-1"><span className="truncate pr-2">{t.type}</span><span>{money(t.amount)}</span></li>
                ))}
                {restTypes.length > 0 && (
                  <li className="flex justify-between border-b pb-1 text-muted-foreground">
                    <span>All other ({restTypes.length} type{restTypes.length === 1 ? "" : "s"})</span><span>{money(restSum)}</span>
                  </li>
                )}
                <li className="flex justify-between pt-1 font-semibold"><span>Total expenses</span><span>{money(pnl.expenses)}</span></li>
              </ul>
            )}
            {pnl.refundsExcluded > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Customer refunds of {money(pnl.refundsExcluded)} are not counted as expenses — the returns already reduce sales.
              </p>
            )}
          </div>

          {(pnl.uncostedRevenue > 0 || pnl.stockOutUnits > 0) && (
            <div className="rounded-xl bg-muted/60 p-3 text-xs space-y-1.5">
              <div className="font-semibold uppercase tracking-wider text-muted-foreground">Data notes</div>
              {pnl.uncostedRevenue > 0 && (
                <p>Sales with no recorded cost price: {money(pnl.uncostedRevenue)}. They count as 100% profit, so gross profit may be overstated — add cost prices to those products.</p>
              )}
              {pnl.stockOutUnits > 0 && (
                <p>Stock removed on Rs 1 bills — not counted as sales: {pnl.stockOutUnits} units, cost {money(pnl.stockOutCost)}.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Line2({ label, hint, v, strong, tone }: { label: string; hint?: string; v: string; strong?: boolean; tone?: "good" | "bad" }) {
  return (
    <li className="flex justify-between items-baseline border-b pb-2 gap-3">
      <span>
        <span className={strong ? "font-semibold" : ""}>{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <b className={tone === "good" ? "text-green-600" : tone === "bad" ? "text-destructive" : ""}>{v}</b>
    </li>
  );
}

function Kpi({ label, v, accent, green, sub }: { label: string; v: string; accent?: boolean; green?: boolean; sub?: string }) {
  return <div className="rounded-2xl bg-card p-5 shadow-sm min-w-0">
    <div className="text-xs uppercase text-muted-foreground tracking-wider">{label}</div>
    <div className={`text-lg sm:text-xl xl:text-2xl font-bold mt-2 tabular-nums break-words ${accent ? "text-destructive" : green ? "text-green-600" : ""}`}>{v}</div>
    {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
  </div>;
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-2xl bg-card p-5 shadow-sm"><div className="font-semibold mb-4">{title}</div>{children}</div>;
}
