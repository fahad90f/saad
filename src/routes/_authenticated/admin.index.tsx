import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, localToday, localDateOf } from "@/lib/format";
import { methodLabel } from "@/lib/payments";
import { normalizeProductName } from "@/lib/pricing";
import { activeProducts, isTracked, oversold, stockOf } from "@/lib/stock";
import { loadMonthPnL, monthLabel, type MonthPnL } from "@/lib/finance";
import { useLiveReload, type LiveStatus } from "@/lib/useLiveReload";
import { fetchAll } from "@/lib/fetchAll";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine, Rectangle, LabelList,
} from "recharts";
import {
  Package, DollarSign, AlertTriangle, LayoutTemplate, Store, UserCircle, Briefcase, Layers,
  RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: Dashboard,
});

// Every table a sale, payment, expense, purchase or stock correction
// touches: a change to any of them refreshes the dashboard.
const LIVE_TABLES = [
  "invoices", "invoice_items", "invoice_payments", "customer_purchases", "client_ledger",
  "expenses", "stock_purchases", "stock_adjustments", "products",
];

// Series colours: the data-viz reference palette, slots 1–3 (blue, orange,
// aqua), validated for colour-blind separation on the white card (light)
// and the navy card (dark). A chart with one series always uses slot 1.
// Chrome (grid, ticks, tooltip) uses the app's own tokens.
const VIZ_VARS =
  "[--viz-1:#2a78d6] [--viz-2:#eb6834] [--viz-3:#1baf7a] " +
  "dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926] dark:[--viz-3:#199e70]";
const S1 = "var(--viz-1)";
const S2 = "var(--viz-2)";
const S3 = "var(--viz-3)";
const GRID = "var(--border)";
const TICK = { fill: "var(--muted-foreground)", fontSize: 11 };
const BAR_CURSOR = { fill: "var(--muted)", fillOpacity: 0.6 };
const LINE_CURSOR = { stroke: "var(--muted-foreground)", strokeOpacity: 0.35 };

// ---------------------------------------------------------------- helpers

const MINUS = "−";
const r2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM of a local date — never toISOString (UTC). */
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const currentMonth = () => localToday().slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  return monthKeyOf(new Date(y, m - 1 + by, 1));
};
/** The last `n` local dates (YYYY-MM-DD), oldest first, ending today. */
const lastDays = (n: number) => {
  const t = new Date();
  return Array.from({ length: n }, (_, i) =>
    localDateOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (n - 1 - i))));
};
const dateOfDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayLabel = (day: string) => dateOfDay(day).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const fullDay = (day: string) =>
  dateOfDay(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const shortMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" });
};
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const compact = (n: number) => compactFmt.format(n);
const units = (n: number) => Math.round(n).toLocaleString();
/** Money with a real minus sign — a loss never reads as a profit. */
const signedMoney = (n: number) => (n < 0 ? MINUS + money(-n) : money(n));
const signedUnits = (n: number) => (n > 0 ? `+${units(n)}` : n < 0 ? `${MINUS}${units(-n)}` : "0");
/** A ledger count that can sit below zero: real minus sign, no plus. */
const netUnits = (n: number) => (n < 0 ? `${MINUS}${units(-n)}` : units(n));
const signedTick = (n: number) => (n > 0 ? `+${compact(n)}` : n < 0 ? `${MINUS}${compact(-n)}` : "0");
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Round axis bounds and whole-unit ticks around a line that need not start at zero. */
function niceScale(lo: number, hi: number, count = 4): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 10], ticks: [0, 5, 10] };
  const span = Math.max(hi - lo, 4);
  const pad = span * 0.08;
  const raw = (span + 2 * pad) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag);
  const a = Math.floor((lo - pad) / step) * step;
  const b = Math.ceil((hi + pad) / step) * step;
  const ticks: number[] = [];
  for (let t = a; t <= b + step / 2; t += step) ticks.push(Math.round(t));
  return { domain: [a, b], ticks };
}

/** Rs 1 lines ring stock out ("Stock Manage", "Claim clear"): stock moves, no sale. Same rule as finance.ts. */
const isStockOutLine = (it: { unit_price?: number | string | null }) => Number(it.unit_price) <= 1;
/** Refunds are not running costs: returns already reduce sales. Same rule as finance.ts. */
const isRefund = (type: string | null | undefined) => String(type ?? "").toLowerCase().includes("refund");
/**
 * The one-time ledger backfill (stamped 2026-10-20 19:21 UTC) recorded stock
 * that was already on the shelf — the July register import and counts typed
 * on the old Products page — so the ledger explains the count. It moved
 * nothing that day, so it is neither a movement nor a step in units on hand.
 * Later "Opening count" rows (new products) and every count/correction are real.
 */
const isBackfill = (a: { reason: string | null; note: string | null }) =>
  a.reason === "Opening stock" ||
  (a.reason === "Opening count" && (a.note ?? "").startsWith("Starting stock entered on the Products page"));

// ------------------------------------------------------------------- data

type Prod = {
  id: string; product_name: string | null; quantity_in_stock: number | null; track_stock: boolean | null;
  purchase_price: number | null; category_id: string | null; deleted_at: string | null;
};
type SaleLine = {
  id: string; product_id: string | null; product_name: string | null;
  quantity: number | null; unit_price: number | null; total_price: number | null;
};
type Inv = { id: string; total_amount: number | null; payment_status: string | null; created_at: string; invoice_items: SaleLine[] | null };
type Expense = { id: string; amount: number | null; expense_type: string | null; date_of_expense: string };
type Purchase = { id: string; product_id: string | null; quantity: number | null; date: string };
type Adjustment = { id: string; product_id: string | null; delta: number | null; reason: string | null; note: string | null; created_at: string };
/** A return row processReturn writes: negative quantity, dated on the sale day, created when the goods came back. */
type ReturnRow = { id: string; product_id: string | null; quantity_purchased: number | null; purchase_date: string; created_at: string };

type DayFlow = { day: string; label: string; received: number; sales: number; expenses: number };
type MonthSales = { key: string; label: string; full: string; sales: number; expenses: number };
/** `in` = bought + returned (`returned` is the part of it that came back from customers). */
type DayMove = { day: string; label: string; in: number; returned: number; outQty: number; out: number; adj: number; onHand: number };

type Dash = {
  counts: { templates: number; products: number; stockUnits: number; employees: number; merchants: number; clients: number };
  stockValue: number;
  today: { received: number; sales: number; expenses: number; byMethod: { name: string; value: number }[] };
  daily: DayFlow[];
  monthly: MonthSales[];
  movement: DayMove[];
  backfillUnits: number;
  /** Ledger count of tracked products: on-shelf units minus oversold units. */
  onHandNow: number;
  /** Units sold before their purchase was booked (counters below zero). */
  oversoldUnits: number;
  stockByCat: { name: string; stock: number }[];
  topSold: { name: string; value: number }[];
  outOfStockRecent: number;
};

const EMPTY: Dash = {
  counts: { templates: 0, products: 0, stockUnits: 0, employees: 0, merchants: 0, clients: 0 },
  stockValue: 0,
  today: { received: 0, sales: 0, expenses: 0, byMethod: [] },
  daily: [], monthly: [], movement: [], backfillUnits: 0, onHandNow: 0, oversoldUnits: 0,
  stockByCat: [], topSold: [], outOfStockRecent: 0,
};

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * Everything on the dashboard except the profit & loss panel. `quiet`
 * (background refresh) suppresses the "could not load" toasts; `ok` is
 * false when any query failed, so the caller can keep its last good figures.
 */
async function loadDashboard(quiet: boolean): Promise<{ data: Dash; ok: boolean }> {
  const today = localToday();
  const now = new Date();
  const days14 = lastDays(14);
  const days30 = lastDays(30);
  const since60 = lastDays(60)[0];
  // Month keys from local dates: new Date(y, m - i, 1), oldest first.
  const months = Array.from({ length: 12 }, (_, i) => monthKeyOf(new Date(now.getFullYear(), now.getMonth() - (11 - i), 1)));
  const start12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const start30 = dateOfDay(days30[0]);
  const opt = { quiet };

  const [prodR, invR, expR, catR, payR, ledR, spR, adjR, retR, tplR, empR, merR, cliR] = await Promise.all([
    fetchAll((a, b) => supabase.from("products")
      .select("id, product_name, quantity_in_stock, track_stock, purchase_price, category_id, deleted_at")
      .order("id").range(a, b), 1000, opt),
    // Every bill of the last 12 months with its lines: sales per day and
    // month (as finance.ts counts them), units out, top sellers.
    fetchAll((a, b) => supabase.from("invoices")
      .select("id, total_amount, payment_status, created_at, invoice_items(id, product_id, product_name, quantity, unit_price, total_price)")
      .gte("created_at", start12.toISOString())
      .order("id").range(a, b), 1000, opt),
    fetchAll((a, b) => supabase.from("expenses")
      .select("id, amount, expense_type, date_of_expense")
      .gte("date_of_expense", `${months[0]}-01`)
      .order("id").range(a, b), 1000, opt),
    supabase.from("categories").select("id, name"),
    fetchAll((a, b) => supabase.from("invoice_payments")
      .select("id, amount, method, payment_date, invoices(client_id)")
      .gte("payment_date", days14[0])
      .order("id").range(a, b), 1000, opt),
    fetchAll((a, b) => supabase.from("client_ledger")
      .select("id, amount, method, entry_date")
      .eq("entry_type", "payment").gte("entry_date", days14[0])
      .order("id").range(a, b), 1000, opt),
    fetchAll((a, b) => supabase.from("stock_purchases")
      .select("id, product_id, quantity, date")
      .gte("date", days30[0])
      .order("id").range(a, b), 1000, opt),
    fetchAll((a, b) => supabase.from("stock_adjustments")
      .select("id, product_id, delta, reason, note, created_at")
      .gte("created_at", start30.toISOString())
      .order("id").range(a, b), 1000, opt),
    // Invoice returns: processReturn shrinks or deletes the sale lines in
    // place (the trigger restocks on the return day) and writes one of
    // these per line. The sale day is never after the return day, so every
    // return that touches the 30-day window happened inside it.
    fetchAll((a, b) => supabase.from("customer_purchases")
      .select("id, product_id, quantity_purchased, purchase_date, created_at")
      .eq("payment_method", "return")
      .gte("created_at", start30.toISOString())
      .order("id").range(a, b), 1000, opt),
    supabase.from("templates").select("*", { count: "exact", head: true }),
    supabase.from("employees").select("*", { count: "exact", head: true }),
    supabase.from("merchants").select("*", { count: "exact", head: true }),
    supabase.from("clients").select("*", { count: "exact", head: true }),
  ]);
  const ok = [prodR, invR, expR, catR, payR, ledR, spR, adjR, retR, tplR, empR, merR, cliR].every((r) => !r.error);

  const allProducts = (prodR.data ?? []) as unknown as Prod[];
  // Stock figures cover the products the shop still carries; a deleted one
  // (Products → Delete) keeps only its name, for old sales.
  const products = activeProducts(allProducts);
  const invoices = (invR.data ?? []) as unknown as Inv[];
  const expenses = (expR.data ?? []) as unknown as Expense[];
  const purchases = (spR.data ?? []) as unknown as Purchase[];
  const adjustments = (adjR.data ?? []) as unknown as Adjustment[];
  const returns = (retR.data ?? []) as unknown as ReturnRow[];
  const cats = (catR.data ?? []) as { id: string; name: string }[];

  const trackedIds = new Set(products.filter(isTracked).map((p) => p.id));
  const nameOf = new Map(allProducts.map((p) => [p.id, p.product_name]));

  // --- Sales and units out, from invoices -------------------------------
  const salesByDay = new Map<string, number>();
  const salesByMonth = new Map<string, number>();
  const outByDay = new Map<string, number>();
  const soldRecently = new Set<string>();
  const sold = new Map<string, { name: string; value: number }>();
  for (const inv of invoices) {
    const day = localDateOf(inv.created_at);
    const items = inv.invoice_items ?? [];
    // Stock leaves with every remaining line — Rs 1 stock-outs and lines
    // left on a cancelled bill included — exactly as the ledger trigger counts.
    for (const it of items) {
      if (it.product_id && trackedIds.has(it.product_id)) add(outByDay, day, Number(it.quantity) || 0);
    }
    if (inv.payment_status === "cancelled") continue;
    // Sales = billed total (returns shrink it in place) minus Rs 1 lines.
    let sale = Number(inv.total_amount) || 0;
    for (const it of items) {
      if (isStockOutLine(it)) { sale -= Number(it.total_price) || 0; continue; }
      const qty = Number(it.quantity) || 0;
      if (qty <= 0) continue;
      if (it.product_id && day >= since60) soldRecently.add(it.product_id);
      const name = (it.product_id && nameOf.get(it.product_id)) || it.product_name;
      if (!name) continue;
      // By product NAME (normalised): two rows spelling the same tyre
      // differently are one bar, not two.
      const key = normalizeProductName(name);
      const cur = sold.get(key);
      sold.set(key, { name: cur?.name ?? name, value: (cur?.value ?? 0) + qty });
    }
    add(salesByDay, day, sale);
    add(salesByMonth, day.slice(0, 7), sale);
  }

  // --- Expenses ----------------------------------------------------------
  const expByDay = new Map<string, number>();     // cash view: everything paid out
  const expByMonth = new Map<string, number>();   // P&L view: refunds left out (as finance.ts)
  for (const e of expenses) {
    const amount = Number(e.amount) || 0;
    add(expByDay, e.date_of_expense, amount);
    if (!isRefund(e.expense_type)) add(expByMonth, e.date_of_expense.slice(0, 7), amount);
  }

  // --- Money received: one row per real payment. Walk-in bills settle
  // through invoice_payments; account customers settle through their ledger
  // (their invoice_payments rows are only allocation records) — the daily
  // closing's rule, so nothing is counted twice.
  const received = [
    ...((payR.data ?? []) as any[])
      .filter((p) => !p.invoices?.client_id)
      .map((p) => ({ amount: Number(p.amount) || 0, date: p.payment_date as string, method: (p.method ?? "cash") as string })),
    ...((ledR.data ?? []) as any[])
      .map((l) => ({ amount: Number(l.amount) || 0, date: l.entry_date as string, method: (l.method ?? "cash") as string })),
  ];
  const recByDay = new Map<string, number>();
  const byMethod = new Map<string, number>();
  for (const r of received) {
    add(recByDay, r.date, r.amount);
    if (r.date === today) add(byMethod, r.method, r.amount);
  }

  const daily: DayFlow[] = days14.map((day) => ({
    day, label: dayLabel(day),
    received: r2(recByDay.get(day) ?? 0),
    sales: r2(salesByDay.get(day) ?? 0),
    expenses: r2(expByDay.get(day) ?? 0),
  }));
  const monthly: MonthSales[] = months.map((key) => ({
    key, label: shortMonth(key), full: monthLabel(key),
    sales: r2(salesByMonth.get(key) ?? 0),
    expenses: r2(expByMonth.get(key) ?? 0),
  }));

  // --- Stock movement and units on hand (tracked products only) ----------
  const lastDay = days30[days30.length - 1];
  const clampDay = (d: string) => (d > lastDay ? lastDay : d); // a purchase dated ahead counts today
  const inByDay = new Map<string, number>();
  const retByDay = new Map<string, number>();
  const adjByDay = new Map<string, number>();
  let backfillUnits = 0;
  for (const sp of purchases) {
    if (sp.product_id && trackedIds.has(sp.product_id)) add(inByDay, clampDay(sp.date), Number(sp.quantity) || 0);
  }
  // A return shrank the sale line in place, so the invoices above count the
  // reduced line on the sale day, while the stock came back on the return
  // day. Put the returned units back into that sale day's "out" and count
  // them as "in" on the day they came back — as the ledger moved them.
  for (const r of returns) {
    if (!r.product_id || !trackedIds.has(r.product_id)) continue;
    const qty = -(Number(r.quantity_purchased) || 0); // stored negative
    if (qty <= 0) continue;
    if (r.purchase_date) add(outByDay, r.purchase_date, qty);
    add(retByDay, clampDay(localDateOf(r.created_at)), qty);
  }
  for (const a of adjustments) {
    if (!a.product_id || !trackedIds.has(a.product_id)) continue;
    const delta = Number(a.delta) || 0;
    if (isBackfill(a)) { backfillUnits += delta; continue; }
    add(adjByDay, clampDay(localDateOf(a.created_at)), delta);
  }
  // Net stock now: the counter the ledger keeps, below zero included, so
  // the line ends exactly on the ledger's count (on-shelf units minus
  // oversold ones).
  const onHandNow = products.filter(isTracked).reduce((s, p) => s + stockOf(p), 0);
  const oversoldUnits = products.reduce((s, p) => s + oversold(p), 0);
  const movement: DayMove[] = days30.map((day) => {
    const outQty = outByDay.get(day) ?? 0;
    const returned = retByDay.get(day) ?? 0;
    return {
      day, label: dayLabel(day), in: (inByDay.get(day) ?? 0) + returned, returned,
      outQty, out: -outQty, adj: adjByDay.get(day) ?? 0, onHand: 0,
    };
  });
  // Walk back from today: the stock at the end of a day is the next day's
  // stock minus what that next day moved — so every step of the line is
  // exactly the movement bar above it.
  let level = onHandNow;
  for (let i = movement.length - 1; i >= 0; i--) {
    movement[i].onHand = level;
    level -= movement[i].in - movement[i].outQty + movement[i].adj;
  }

  // --- Stock on hand -------------------------------------------------------
  // Services and trade-ins are never stock; a tracked product sold before
  // its purchase was booked sits below zero — that is "out of stock", never
  // a negative unit count or value.
  const onHand = (x: Prod) => (isTracked(x) && stockOf(x) > 0 ? stockOf(x) : 0);
  const stockValue = products.reduce((a, x) => a + (Number(x.purchase_price) || 0) * onHand(x), 0);
  const stockUnits = products.reduce((a, x) => a + onHand(x), 0);
  // Most products carry no category; they used to vanish from this chart.
  const catIds = new Set(cats.map((c) => c.id));
  const stockByCat = [
    ...cats.map((c) => ({ name: c.name, stock: products.filter((x) => x.category_id === c.id).reduce((a, x) => a + onHand(x), 0) })),
    { name: "Uncategorised", stock: products.filter((x) => !x.category_id || !catIds.has(x.category_id)).reduce((a, x) => a + onHand(x), 0) },
  ].filter((x) => x.stock > 0);

  // Reorder alert: only what customers actually bought lately. Hundreds of
  // dead or one-off products sit at zero and would drown the real gaps.
  // Counted by product NAME: a sold-out duplicate row is no gap while
  // another row of the same name still has stock, and two sold-out
  // duplicates are one product to reorder, not two.
  const nameKey = (x: Prod) => normalizeProductName(x.product_name) || `#${x.id}`;
  const namesInStock = new Set(products.filter((x) => isTracked(x) && stockOf(x) > 0).map(nameKey));
  const outOfStockRecent = new Set(
    products
      .filter((x) => isTracked(x) && stockOf(x) <= 0 && soldRecently.has(x.id) && !namesInStock.has(nameKey(x)))
      .map(nameKey),
  ).size;

  return {
    ok,
    data: {
      counts: {
        templates: tplR.count ?? 0, products: products.length, stockUnits,
        employees: empR.count ?? 0, merchants: merR.count ?? 0, clients: cliR.count ?? 0,
      },
      stockValue: r2(stockValue),
      today: {
        received: r2(recByDay.get(today) ?? 0),
        sales: r2(salesByDay.get(today) ?? 0),
        expenses: r2(expByDay.get(today) ?? 0),
        byMethod: [...byMethod].map(([m, v]) => ({ name: methodLabel(m), value: r2(v) })),
      },
      daily, monthly, movement, backfillUnits, onHandNow, oversoldUnits, stockByCat,
      topSold: [...sold.values()].sort((a, b) => b.value - a.value).slice(0, 5),
      outOfStockRecent,
    },
  };
}

// --------------------------------------------------------------- the page

type Fin = { month: string; cur: MonthPnL; prev: MonthPnL };
type RefreshOpts = { quiet: boolean; finance: boolean };

function Dashboard() {
  const [dash, setDash] = useState<Dash>(EMPTY);
  const [loads, setLoads] = useState(0);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [month, setMonth] = useState(currentMonth);
  const [fin, setFin] = useState<Fin | null>(null);
  const [finBusy, setFinBusy] = useState(false);

  const mounted = useRef(true);
  const hasData = useRef(false);
  const busy = useRef(false);
  const pending = useRef<RefreshOpts | null>(null);
  const finSeq = useRef(0);       // last P&L load started
  const finShownSeq = useRef(0);  // the load whose figures are on screen
  const finLoudSeq = useRef(0);   // last owner-initiated (non-quiet) load
  const monthRef = useRef(month);
  // Follow the calendar (roll to the new month at midnight) until the owner
  // picks another month.
  const followCurrent = useRef(true);
  const refreshRef = useRef<(o: RefreshOpts) => Promise<void>>(async () => {});

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { monthRef.current = month; }, [month]);

  const { status, lastUpdated, markUpdated } = useLiveReload(
    LIVE_TABLES,
    () => { void refreshRef.current({ quiet: true, finance: true }); },
  );

  const loadFinance = useCallback(async (m: string, quiet: boolean) => {
    const seq = ++finSeq.current;
    if (!quiet) { finLoudSeq.current = seq; setFinBusy(true); }
    try {
      const [cur, prev] = await Promise.all([loadMonthPnL(m, { quiet }), loadMonthPnL(shiftMonth(m, -1), { quiet })]);
      // A failed background refresh keeps the figures already on screen
      // rather than replacing them with incomplete ones.
      if (quiet && (cur.error || prev.error)) return;
      // Show figures only for the month now picked, and never over figures
      // from a load that started later. A later load that failed quietly
      // (or is still running) does not throw this one away — so the month
      // the owner just picked still arrives when a live refresh fails.
      if (!mounted.current || m !== monthRef.current || seq < finShownSeq.current) return;
      finShownSeq.current = seq;
      setFin({ month: m, cur, prev });
    } catch {
      // keep the figures already on screen
    } finally {
      // Busy until the owner's latest load lands — a background load
      // finishing first does not clear it.
      if (mounted.current && seq === finLoudSeq.current) setFinBusy(false);
    }
  }, []);

  // One load at a time: a change that lands mid-load queues exactly one
  // more run, so a burst of events never stacks up overlapping loads.
  const refresh = useCallback(async (o: RefreshOpts) => {
    if (busy.current) {
      const p = pending.current;
      pending.current = p ? { quiet: p.quiet && o.quiet, finance: p.finance || o.finance } : o;
      return;
    }
    busy.current = true;
    if (!o.quiet) setRefreshing(true);
    try {
      let result: { data: Dash; ok: boolean } | null = null;
      try { result = await loadDashboard(o.quiet); } catch { result = null; }
      if (!mounted.current) return;
      const ok = !!result?.ok;
      // A failed background load keeps the last good figures on screen.
      if (result && (ok || !hasData.current)) {
        hasData.current = true;
        setDash(result.data);
        setLoads((n) => n + 1);
      }
      if (ok) markUpdated();
      setStale(!ok);

      if (o.finance) {
        const cm = currentMonth();
        if (followCurrent.current && monthRef.current !== cm) {
          monthRef.current = cm;
          setMonth(cm); // the month effect loads the panel
        } else if (ok) {
          // Live updates reload whichever month is picked: past months
          // change too (backdated sales, returns shrinking old bills,
          // expenses entered with any date). A failed quiet load keeps the
          // figures on screen.
          await loadFinance(monthRef.current, o.quiet);
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) setRefreshing(false);
      const next = pending.current;
      pending.current = null;
      if (next && mounted.current) void refreshRef.current(next);
    }
  }, [loadFinance, markUpdated]);

  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { void refresh({ quiet: false, finance: false }); }, [refresh]);
  useEffect(() => { void loadFinance(month, false); }, [month, loadFinance]);

  const pickMonth = (m: string) => {
    followCurrent.current = m === currentMonth();
    // At once, not after the render: a load for the old month landing in
    // between must not be taken for this one.
    monthRef.current = m;
    setMonth(m);
  };

  // Charts draw in once; later live updates change in place without the
  // grow-from-zero redraw flicker.
  const animate = loads <= 1;

  const counts = [
    { label: "Templates", value: dash.counts.templates, icon: LayoutTemplate, color: "text-primary" },
    { label: "Products", value: dash.counts.products, icon: Package, color: "text-primary" },
    { label: "Stock units", value: dash.counts.stockUnits, icon: Layers, color: "text-primary" },
    { label: "Employees", value: dash.counts.employees, icon: Briefcase, color: "text-orange-500" },
    { label: "Merchants", value: dash.counts.merchants, icon: Store, color: "text-orange-500" },
    { label: "Clients", value: dash.counts.clients, icon: UserCircle, color: "text-orange-500" },
  ];

  const moneyCards = [
    { label: "Total Stock Value", value: dash.stockValue, icon: Package, color: "text-primary" },
    { label: "Today's Sales", value: dash.today.sales, icon: DollarSign, color: "text-green-600" },
  ];

  const mv = dash.movement;
  const mvTotals = mv.reduce(
    (t, d) => ({ in: t.in + d.in, returned: t.returned + d.returned, out: t.out + d.outQty, adj: t.adj + d.adj }),
    { in: 0, returned: 0, out: 0, adj: 0 },
  );
  const onHandValues = mv.map((d) => d.onHand);
  const onHandAxis = niceScale(
    onHandValues.length ? Math.min(...onHandValues) : 0,
    onHandValues.length ? Math.max(...onHandValues) : 0,
  );
  const thisMonthSales = dash.monthly.length ? dash.monthly[dash.monthly.length - 1].sales : 0;
  const todayFlow = dash.daily.length ? dash.daily[dash.daily.length - 1] : null;
  const recentFirst = <T,>(rows: T[]) => [...rows].reverse();

  return (
    <AdminShell title="Dashboard">
      <div className={VIZ_VARS}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <LiveBadge status={status} lastUpdated={lastUpdated} stale={stale} />
          <button
            type="button"
            onClick={() => { void refresh({ quiet: false, finance: true }); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs shadow-sm hover:bg-muted disabled:opacity-60"
            disabled={refreshing}
            aria-label="Refresh dashboard now"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {counts.map((c, i) => (
            <motion.div key={c.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                        className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{c.label}</div>
                <c.icon className={`h-4 w-4 ${c.color}`} />
              </div>
              <div className={`text-2xl font-black mt-1 ${c.color}`}><CountUp value={c.value} /></div>
            </motion.div>
          ))}
        </div>

        <FinancePanel month={month} onMonth={pickMonth} fin={fin} busy={finBusy} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          {moneyCards.map((c, i) => (
            <motion.div key={c.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
                        className="rounded-2xl bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase text-muted-foreground tracking-wider">{c.label}</div>
                <c.icon className={`h-5 w-5 ${c.color}`} />
              </div>
              <div className={`text-2xl font-black mt-2 ${c.color}`}>
                <CountUp value={c.value} format={money} />
              </div>
            </motion.div>
          ))}
        </div>

        {dash.outOfStockRecent > 0 && (
          <div className="mt-4 rounded-xl bg-destructive/10 text-destructive px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span title="Stock-tracked products at or below zero that sold in the last 60 days, counted by name — a name with stock on another product row is left out">
              {dash.outOfStockRecent} product{dash.outOfStockRecent > 1 ? "s" : ""} that sold recently{" "}
              {dash.outOfStockRecent > 1 ? "are" : "is"} out of stock — reorder
            </span>
            <Link to="/admin/products" className="ml-auto font-semibold underline underline-offset-2 hover:no-underline">
              View products
            </Link>
          </div>
        )}

        {/* Today at a glance */}
        <div className="mt-6">
          <div className="font-semibold mb-3">Today at a glance</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Payments received</div>
              <div className="text-2xl font-black mt-1 text-green-600">{money(dash.today.received)}</div>
              <div className="mt-2 space-y-0.5">
                {dash.today.byMethod.length === 0
                  ? <div className="text-xs text-muted-foreground">No payments yet today</div>
                  : dash.today.byMethod.map((m) => (
                    <div key={m.name} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{m.name}</span><span>{money(m.value)}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Net sales today</div>
              <div className="text-2xl font-black mt-1">{money(dash.today.sales)}</div>
            </div>
            <div className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Expenses today</div>
              <div className="text-2xl font-black mt-1 text-orange-500">{money(dash.today.expenses)}</div>
            </div>
            <div className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Net cash (in − out)</div>
              <div className={`text-2xl font-black mt-1 ${dash.today.received - dash.today.expenses >= 0 ? "text-green-600" : "text-destructive"}`}>
                {signedMoney(dash.today.received - dash.today.expenses)}
              </div>
            </div>
          </div>
        </div>

        {/* One graph per series. Drawn together, received and sales are the
            same magnitude and cross each other while expenses hug the floor —
            on a phone that is one tangle, not three graphs. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          {([
            { key: "received", title: "Payments received", name: "received" },
            { key: "sales", title: "Sales", name: "sales" },
            { key: "expenses", title: "Expenses", name: "paid out" },
          ] as const).map((s) => (
            <Chart
              key={s.key}
              title={s.title}
              subtitle="Last 14 days, Rs"
              aside={<Aside label="Today" value={money(todayFlow?.[s.key] ?? 0)} />}
              table={{
                head: ["Day", s.title],
                rows: recentFirst(dash.daily).map((d) => [fullDay(d.day), money(d[s.key])]),
              }}
            >
              <Trend data={dash.daily} dataKey={s.key} name={s.name} animate={animate} />
            </Chart>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
          <Chart
            title="Monthly sales — last 12 months"
            subtitle="Billed sales net of returns, Rs · Rs 1 stock-out bills left out"
            aside={<Aside label="This month" value={money(thisMonthSales)} />}
            table={{
              head: ["Month", "Sales", "Expenses"],
              rows: recentFirst(dash.monthly).map((m) => [m.full, money(m.sales), money(m.expenses)]),
            }}
          >
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dash.monthly} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={4} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={compact} />
                <Tooltip
                  cursor={BAR_CURSOR}
                  content={<ChartTip title={(d: MonthSales) => d.full} rows={(d: MonthSales) => [
                    { name: "sales", value: money(d.sales), color: S1 },
                    { name: "expenses (not drawn)", value: money(d.expenses) },
                  ]} />}
                />
                <Bar dataKey="sales" name="Sales" fill={S1} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={animate} />
              </BarChart>
            </ResponsiveContainer>
          </Chart>

          <Chart
            title="Stock movement — last 30 days"
            subtitle="Units of stock-tracked products per day"
            legend={<LegendRow items={[
              { label: "In (bought or returned)", color: S1, value: signedUnits(mvTotals.in) },
              { label: "Out (sold or removed)", color: S2, value: signedUnits(-mvTotals.out) },
              { label: "Adjustments", color: S3, value: signedUnits(mvTotals.adj) },
            ]} />}
            note={[
              mvTotals.returned > 0
                ? `${units(mvTotals.returned)} unit${mvTotals.returned === 1 ? "" : "s"} of "in" came back on invoice returns — counted on the day they came back, and still as sold on the day of the sale.`
                : "",
              dash.backfillUnits !== 0
                ? `The one-time opening-stock entries made when the stock ledger started (${signedUnits(dash.backfillUnits)} units) record stock already on the shelf, so they are not drawn as movement.`
                : "",
            ].filter(Boolean).join(" ") || undefined}
            table={{
              head: ["Day", "In", "Of which returned", "Out", "Adjusted", "Net"],
              rows: recentFirst(mv).map((d) => [
                fullDay(d.day), signedUnits(d.in), d.returned ? units(d.returned) : "—", signedUnits(-d.outQty), signedUnits(d.adj),
                signedUnits(d.in - d.outQty + d.adj),
              ]),
            }}
          >
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={mv} stackOffset="sign" barCategoryGap="20%" margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} tickFormatter={signedTick} />
                <Tooltip
                  cursor={BAR_CURSOR}
                  content={<ChartTip title={(d: DayMove) => fullDay(d.day)} rows={(d: DayMove) => [
                    { name: "in", value: signedUnits(d.in), color: S1 },
                    ...(d.returned ? [{ name: "of which returned", value: units(d.returned) }] : []),
                    { name: "out", value: signedUnits(-d.outQty), color: S2 },
                    { name: "adjusted", value: signedUnits(d.adj), color: S3 },
                    { name: "net", value: signedUnits(d.in - d.outQty + d.adj) },
                  ]} />}
                />
                <Bar dataKey="in" name="In" stackId="move" fill={S1} maxBarSize={24} shape={stackSegment("in")} isAnimationActive={animate} />
                <Bar dataKey="out" name="Out" stackId="move" fill={S2} maxBarSize={24} shape={stackSegment("out")} isAnimationActive={animate} />
                <Bar dataKey="adj" name="Adjustments" stackId="move" fill={S3} maxBarSize={24} shape={stackSegment("adj")} isAnimationActive={animate} />
                <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.6} />
              </BarChart>
            </ResponsiveContainer>
          </Chart>

          <Chart
            title="Net stock — last 30 days"
            subtitle="Ledger count of stock-tracked products (oversold units subtracted)"
            aside={<Aside label="Net now" value={netUnits(dash.onHandNow)} />}
            note={dash.oversoldUnits > 0
              ? `${units(dash.counts.stockUnits)} on shelf · ${units(dash.oversoldUnits)} oversold`
              : undefined}
            table={{
              head: ["Day", "Net stock"],
              rows: recentFirst(mv).map((d) => [fullDay(d.day), netUnits(d.onHand)]),
            }}
          >
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={mv} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} allowDecimals={false}
                       domain={onHandAxis.domain} ticks={onHandAxis.ticks} tickFormatter={compact} />
                <Tooltip
                  cursor={LINE_CURSOR}
                  content={<ChartTip title={(d: DayMove) => fullDay(d.day)} rows={(d: DayMove) => [
                    { name: "net stock", value: netUnits(d.onHand), color: S1 },
                  ]} />}
                />
                <Line type="linear" dataKey="onHand" name="Net stock" stroke={S1} strokeWidth={2}
                      strokeLinecap="round" strokeLinejoin="round" dot={endDot(mv.length - 1)}
                      activeDot={{ r: 5, fill: S1, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={animate} />
              </LineChart>
            </ResponsiveContainer>
          </Chart>

          <Chart
            title="In-stock by category"
            subtitle="Units on hand"
            table={{ head: ["Category", "Units"], rows: dash.stockByCat.map((c) => [c.name, units(c.stock)]) }}
          >
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dash.stockByCat} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="name" tick={{ ...TICK, fontSize: 10 }} tickLine={false} axisLine={{ stroke: GRID }} interval={0} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} tickFormatter={compact} />
                <Tooltip
                  cursor={BAR_CURSOR}
                  content={<ChartTip title={(d: { name: string; stock: number }) => d.name} rows={(d) => [
                    { name: "units in stock", value: units(d.stock), color: S1 },
                  ]} />}
                />
                <Bar dataKey="stock" name="Units" fill={S1} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={animate} />
              </BarChart>
            </ResponsiveContainer>
          </Chart>

          <Chart
            title="Top-selling products"
            subtitle="Units sold, last 12 months · Rs 1 stock-out bills left out"
            table={{ head: ["Product", "Units sold"], rows: dash.topSold.map((t) => [t.name, units(t.value)]) }}
          >
            {dash.topSold.length === 0 ? (
              <div className="h-[160px] grid place-items-center text-sm text-muted-foreground">No sales recorded yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={dash.topSold.length * 40 + 16}>
                <BarChart data={dash.topSold} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }}>
                  <XAxis type="number" hide domain={[0, "dataMax"]} />
                  <YAxis type="category" dataKey="name" width={124} tick={TICK} tickLine={false} axisLine={false}
                         tickFormatter={(s: string) => truncate(s, 18)} />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    content={<ChartTip title={(d: { name: string; value: number }) => d.name} rows={(d) => [
                      { name: "units sold", value: units(d.value), color: S1 },
                    ]} />}
                  />
                  <Bar dataKey="value" name="Units sold" fill={S1} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={animate}>
                    <LabelList dataKey="value" position="right" fill="var(--foreground)" fontSize={11} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Chart>
        </div>
      </div>
    </AdminShell>
  );
}

// ---------------------------------------------------------- live badge

function LiveBadge({ status, lastUpdated, stale }: { status: LiveStatus; lastUpdated: Date | null; stale: boolean }) {
  const time = lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let dot = "bg-muted-foreground";
  let text: ReactNode = "Connecting…";
  if (stale && time) {
    dot = "bg-[#d03b3b]";
    text = `Couldn't refresh — showing figures from ${time}`;
  } else if (status === "live") {
    dot = "bg-[#0ca30c]";
    text = time ? `Live · updated ${time}` : "Live";
  } else if (status === "offline") {
    dot = "bg-[#fab219]";
    text = <>Offline — refreshing every 20 s{time && <span className="hidden sm:inline"> · updated {time}</span>}</>;
  }
  return (
    <div className="inline-flex min-w-0 items-center gap-2 rounded-full bg-card px-3 py-1 text-xs shadow-sm">
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        {status === "live" && !stale && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#0ca30c] opacity-60 motion-safe:animate-ping" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className="truncate">{text}</span>
    </div>
  );
}

// ---------------------------------------------------- profit & loss panel

function FinancePanel({ month, onMonth, fin, busy }: {
  month: string; onMonth: (m: string) => void; fin: Fin | null; busy: boolean;
}) {
  const nowMonth = currentMonth();
  const options = Array.from({ length: 12 }, (_, i) => shiftMonth(nowMonth, -i));
  if (!options.includes(month)) options.push(month);
  const isCurrent = month === nowMonth;
  // Another month's figures never show under this month's name: until the
  // picked month has loaded, the tiles show "—".
  const shown = fin && fin.month === month ? fin : null;
  const cur = shown?.cur;
  const prev = shown?.prev;
  const net = cur?.netProfit ?? 0;
  const largest = cur?.expensesByType[0];

  const tiles: { label: string; value: number | null; format: (n: number) => string; tone?: string; sub?: ReactNode }[] = [
    {
      label: "Sales", value: cur?.revenue ?? null, format: money,
      sub: cur ? `${cur.invoiceCount.toLocaleString()} bill${cur.invoiceCount === 1 ? "" : "s"}` : null,
    },
    { label: "Cost of goods", value: cur?.cogs ?? null, format: money, sub: "Cost price of units sold" },
    {
      label: "Gross profit", value: cur?.grossProfit ?? null, format: signedMoney,
      tone: cur && cur.grossProfit < 0 ? "text-destructive" : undefined,
      sub: cur?.grossMargin != null ? `${(cur.grossMargin * 100).toFixed(1)}% margin` : "No sales",
    },
    {
      label: "Expenses", value: cur?.expenses ?? null, format: money, tone: "text-orange-500",
      sub: largest ? `Largest: ${largest.type} ${money(largest.amount)}` : "None recorded",
    },
    {
      label: net < 0 ? "Net loss" : "Net profit", value: cur?.netProfit ?? null, format: signedMoney,
      tone: cur ? (net < 0 ? "text-destructive" : "text-green-600") : undefined,
      sub: "Gross profit − expenses − stock written off",
    },
    {
      label: "Total loss", value: cur?.totalLoss ?? null, format: money,
      tone: cur && cur.totalLoss > 0 ? "text-destructive" : undefined,
      sub: cur ? (
        <span className="block space-y-0.5">
          <span className="block">Sales below cost {money(cur.belowCostLoss)}</span>
          <span className="block">Stock written off {money(cur.writeOffs)}</span>
          <span className="block">Other loss {money(cur.otherLoss)}</span>
        </span>
      ) : null,
    },
  ];

  const notes: string[] = [];
  if (cur && cur.stockOutUnits > 0) {
    notes.push(`${cur.stockOutUnits.toLocaleString()} unit${cur.stockOutUnits === 1 ? "" : "s"} removed on Rs 1 bills — not counted as sales`);
  }
  if (cur && cur.refundsExcluded > 0) {
    notes.push(`${money(cur.refundsExcluded)} of customer refunds left out of expenses — returns already reduce sales`);
  }
  if (cur && cur.uncostedRevenue > 0) {
    notes.push(`${money(cur.uncostedRevenue)} of sales has no cost price recorded, so it counts as full profit`);
  }

  return (
    <section className="mt-4 rounded-2xl bg-card p-4 sm:p-5 shadow-sm" aria-labelledby="pl-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="pl-title" className="font-semibold leading-tight">{isCurrent ? "This month" : monthLabel(month)} — profit &amp; loss</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {monthLabel(month)}{isCurrent ? " · month so far" : ""} · same figures as the Reports page
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="sr-only sm:not-sr-only">Month</span>
          <select
            value={month}
            onChange={(e) => onMonth(e.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {options.map((m) => (
              <option key={m} value={m}>{m === nowMonth ? `This month (${monthLabel(m)})` : monthLabel(m)}</option>
            ))}
          </select>
        </label>
      </div>

      <div className={`grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3 mt-4 transition-opacity ${busy ? "opacity-60" : ""}`} aria-busy={busy}>
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-muted/50 p-3 min-w-0">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{t.label}</div>
            <div className={`text-base sm:text-xl font-black mt-1 ${t.tone ?? ""}`}>
              {t.value === null ? "—" : <CountUp value={t.value} format={t.format} />}
            </div>
            {t.sub && <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{t.sub}</div>}
          </div>
        ))}
      </div>

      {cur && prev && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            vs {monthLabel(prev.month)}{isCurrent ? " (month so far vs the whole month)" : ""}:
          </span>
          <Delta label="Sales" now={cur.revenue} before={prev.revenue} />
          <Delta label="Net profit" now={cur.netProfit} before={prev.netProfit} />
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </section>
  );
}

function Delta({ label, now, before }: { label: string; now: number; before: number }) {
  const d = r2(now - before);
  const pct = before !== 0 ? (d / Math.abs(before)) * 100 : null;
  const Icon = d > 0 ? ArrowUpRight : d < 0 ? ArrowDownRight : Minus;
  const tone = d > 0 ? "text-green-600" : d < 0 ? "text-destructive" : "text-muted-foreground";
  const sign = d > 0 ? "+" : d < 0 ? MINUS : "";
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={`h-3.5 w-3.5 ${tone}`} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${tone}`}>
        {sign}{money(Math.abs(d))}
        {pct !== null && Number.isFinite(pct) ? ` (${sign}${Math.abs(pct).toFixed(0)}%)` : ""}
      </span>
    </span>
  );
}

// ------------------------------------------------------------- pieces

/**
 * A number that glides from what it showed before to its new value — never
 * back from 0 — so a live update reads as a change, not a flash.
 */
function CountUp({ value, format = units }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { shownRef.current = value; setShown(value); return; }
    const start = performance.now();
    const duration = 700;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const v = k >= 1 ? value : from + (value - from) * (1 - Math.pow(1 - k, 3));
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span>{format(shown === value ? value : Math.round(shown))}</span>;
}

function Chart({ title, subtitle, aside, legend, note, table, children }: {
  title: string;
  subtitle?: string;
  aside?: ReactNode;
  legend?: ReactNode;
  note?: string;
  table?: { head: string[]; rows: string[][] };
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-card p-4 sm:p-5 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {aside && <div className="text-right shrink-0">{aside}</div>}
      </div>
      {legend}
      {children}
      {note && <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>}
      {table && <ChartTable head={table.head} rows={table.rows} />}
    </section>
  );
}

function Aside({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </>
  );
}

/** Every chart's values without hovering: the accessible twin of the graph. */
function ChartTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">Show as table</summary>
      <div className="mt-2 max-h-60 overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={`px-2 py-1.5 font-medium text-muted-foreground ${i ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                {r.map((c, j) => <td key={j} className={`px-2 py-1 ${j ? "text-right" : "text-left"}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function LegendRow({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs mb-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color }} />
          <span className="text-muted-foreground">{i.label}</span>
          {i.value && <span className="font-semibold tabular-nums">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

type TipRow = { name: string; value: string; color?: string };

/** Tooltip: value first (strong), series name after, a short line key in the series colour. */
function ChartTip<D>({ active, payload, title, rows }: {
  active?: boolean;
  payload?: { payload?: D }[];
  title: (d: D) => string;
  rows: (d: D) => TipRow[];
}) {
  const d = payload?.[0]?.payload;
  if (!active || d === undefined) return null;
  return (
    <div className="rounded-lg border border-border bg-popover text-popover-foreground shadow-md px-3 py-2 text-xs min-w-[9rem]">
      <div className="text-muted-foreground mb-1">{title(d)}</div>
      {rows(d).map((r) => (
        <div key={r.name} className="flex items-center gap-2 py-0.5">
          <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color ?? "transparent" }} />
          <span className="font-semibold text-sm tabular-nums">{r.value}</span>
          <span className="text-muted-foreground">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Marker on the last point only: where the series stands now. */
const endDot = (last: number) => (props: { cx?: number; cy?: number; index?: number }) =>
  props.index === last && props.cx != null && props.cy != null
    ? <circle key="end" cx={props.cx} cy={props.cy} r={4} fill={S1} stroke="var(--card)" strokeWidth={2} />
    : <g key={`dot-${props.index}`} />;

/**
 * A segment of the in / out / adjustment stack. Only the outermost segment
 * on each side of zero gets the rounded data end (4px); the card-coloured
 * stroke is the 2px surface gap between touching segments.
 */
const stackSegment = (key: "in" | "out" | "adj") => (props: any) => {
  const d = (props?.payload ?? {}) as Partial<DayMove>;
  const adj = d.adj ?? 0;
  const outer = key === "adj" || (key === "in" ? !(adj > 0) : !(adj < 0));
  return <Rectangle {...props} stroke="var(--card)" strokeWidth={2} radius={outer ? [4, 4, 0, 0] : [0, 0, 0, 0]} />;
};

/** One 14-day series on its own axes. */
function Trend({ data, dataKey, name, animate }: {
  data: DayFlow[]; dataKey: "received" | "sales" | "expenses"; name: string; animate: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={compact} />
        <Tooltip
          cursor={LINE_CURSOR}
          content={<ChartTip title={(d: DayFlow) => fullDay(d.day)} rows={(d: DayFlow) => [
            { name, value: money(d[dataKey]), color: S1 },
          ]} />}
        />
        <Line type="linear" dataKey={dataKey} name={name} stroke={S1} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" dot={endDot(data.length - 1)}
              activeDot={{ r: 5, fill: S1, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={animate} />
      </LineChart>
    </ResponsiveContainer>
  );
}
