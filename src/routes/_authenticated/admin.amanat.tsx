import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { supabase } from "@/integrations/supabase/client";
import { money, shortDate, localToday } from "@/lib/format";
import { matchesQuery } from "@/lib/search";
import { fetchAll } from "@/lib/fetchAll";
import { stockLabel } from "@/lib/stock";
import {
  AmanatForm, DirectionChip, StatusChip, AMANAT_SELECT, PARTY_COLUMNS, PARTY_WORD,
  amanatTotals, amanatWhat, isOverdue, isPending, outstandingQty, partyOf, settledWord,
  setAmanatReceived, setAmanatReturnedQty, deleteAmanat,
  type AmanatParty, type AmanatPartyType, type AmanatProduct, type AmanatRow,
} from "@/components/admin/AmanatForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  Search, PackageCheck, Trash2, Undo2, Phone, AlertTriangle, Pencil, ArrowUpRight, ArrowDownLeft,
  type LucideIcon,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/amanat")({
  component: AmanatPage,
});

type StatusFilter = "pending" | "received" | "all";
type DirectionFilter = "both" | "taken" | "left";

function AmanatPage() {
  const [rows, setRows] = useState<AmanatRow[]>([]);
  const [products, setProducts] = useState<AmanatProduct[]>([]);
  const [clients, setClients] = useState<AmanatParty[]>([]);
  const [merchants, setMerchants] = useState<AmanatParty[]>([]);
  const [partyTab, setPartyTab] = useState<AmanatPartyType>("client");
  const [statusTab, setStatusTab] = useState<StatusFilter>("pending");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("both");
  const [q, setQ] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AmanatRow | null>(null);

  const load = async () => {
    const [a, p, c, m] = await Promise.all([
      fetchAll((from, to) => supabase.from("amanat_items").select(AMANAT_SELECT)
        .order("given_date", { ascending: false }).order("created_at", { ascending: false }).order("id").range(from, to)),
      fetchAll((from, to) => supabase.from("products").select("id, product_name, quantity_in_stock, track_stock, deleted_at")
        .order("product_name").order("id").range(from, to)),
      fetchAll((from, to) => supabase.from("clients").select(PARTY_COLUMNS).order("name").order("id").range(from, to)),
      fetchAll((from, to) => supabase.from("merchants").select(PARTY_COLUMNS).order("name").order("id").range(from, to)),
    ]);
    setRows(a.data as unknown as AmanatRow[]);
    setProducts(p.data as AmanatProduct[]);
    setClients(c.data as AmanatParty[]);
    setMerchants(m.data as AmanatParty[]);
  };
  useEffect(() => { load(); }, []);

  const today = localToday();
  const tabRows = useMemo(() => rows.filter((r) => (r.party_type === "merchant" ? "merchant" : "client") === partyTab), [rows, partyTab]);
  const filtered = useMemo(() => tabRows.filter((r) => {
    if (statusTab === "pending" && !isPending(r)) return false;
    if (statusTab === "received" && isPending(r)) return false;
    if (dirFilter !== "both" && r.direction !== dirFilter) return false;
    if (q) {
      const p = partyOf(r);
      const text = [r.amanat_no, r.customer_name, r.phone, r.contact, r.item_name, r.notes, p?.account_no, p?.name, p?.phone]
        .filter(Boolean).join(" ");
      if (!matchesQuery(text, q)) return false;
    }
    return true;
  }), [tabRows, statusTab, dirFilter, q]);

  const pendingCount = (t: AmanatPartyType) => rows.filter((r) => (r.party_type === "merchant" ? "merchant" : "client") === t && isPending(r)).length;
  const taken = amanatTotals(tabRows, "taken");
  const left = amanatTotals(tabRows, "left");
  const overdue = tabRows.filter((r) => isOverdue(r, today)).length;
  const received = tabRows.filter((r) => !isPending(r)).length;
  const detail = detailId ? rows.find((r) => r.id === detailId) ?? null : null;

  const toggleReceived = async (r: AmanatRow) => {
    const err = await setAmanatReceived(r, isPending(r));
    if (err) return toast.error(err);
    toast.success(isPending(r) ? `${amanatWhat(r)} — ${settledWord(r).toLowerCase()}` : `${r.amanat_no ?? "Amanat"} reopened`);
    load();
  };
  const remove = async (r: AmanatRow) => {
    if (!confirm(`Delete amanat ${r.amanat_no ?? ""} (${amanatWhat(r)})?${r.from_stock && isPending(r) ? "\n\nUnits taken from shelf stock go back to stock." : ""}`)) return;
    const err = await deleteAmanat(r.id);
    if (err) return toast.error(err);
    toast.success("Deleted");
    setDetailId(null);
    load();
  };

  return (
    <AdminShell title="Amanat">
      <Tabs value={partyTab} onValueChange={(v) => setPartyTab(v as AmanatPartyType)} className="mb-4">
        <TabsList>
          <TabsTrigger value="client">Customer Amanat{pendingCount("client") ? ` (${pendingCount("client")})` : ""}</TabsTrigger>
          <TabsTrigger value="merchant">Merchant Amanat{pendingCount("merchant") ? ` (${pendingCount("merchant")})` : ""}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi icon={ArrowUpRight} label="Pending · they took from us" value={`${taken.items} items`} sub={taken.rs ? money(taken.rs) : undefined} tone={taken.count ? "orange" : undefined} />
        <Kpi icon={ArrowDownLeft} label="Pending · they left with us" value={`${left.items} items`} sub={left.rs ? money(left.rs) : undefined} tone={left.count ? "blue" : undefined} />
        <Kpi icon={AlertTriangle} label="Overdue" value={String(overdue)} tone={overdue ? "red" : undefined} />
        <Kpi icon={PackageCheck} label="Received" value={String(received)} tone="green" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-card p-5 shadow-sm space-y-3 h-fit">
          <div className="font-semibold">New {PARTY_WORD[partyTab]} Amanat</div>
          <AmanatForm key={partyTab} partyType={partyTab}
                      clients={clients} merchants={merchants} products={products}
                      onSaved={() => load()} onPartyCreated={() => load()} />
        </div>

        <div className="lg:col-span-2 min-w-0 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Tabs value={statusTab} onValueChange={(v) => setStatusTab(v as StatusFilter)}>
              <TabsList>
                <TabsTrigger value="pending">Pending{taken.count + left.count ? ` (${taken.count + left.count})` : ""}</TabsTrigger>
                <TabsTrigger value="received">Received</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs value={dirFilter} onValueChange={(v) => setDirFilter(v as DirectionFilter)}>
              <TabsList>
                <TabsTrigger value="taken">Taken</TabsTrigger>
                <TabsTrigger value="left">Left</TabsTrigger>
                <TabsTrigger value="both">Both</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search ref, name, phone, item..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
          </div>

          <div className="rounded-2xl bg-card shadow-sm overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Ref</th><th className="p-3">Date</th><th className="p-3">{PARTY_WORD[partyTab]}</th>
                  <th className="p-3">Item / Amount</th><th className="p-3">Qty</th><th className="p-3">Direction</th><th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const p = partyOf(r);
                  const late = isOverdue(r, today);
                  const out = outstandingQty(r);
                  return (
                    <tr key={r.id} className="border-t hover:bg-muted/40 cursor-pointer" onClick={() => setDetailId(r.id)}>
                      <td className="p-3 font-mono text-xs text-primary whitespace-nowrap">{r.amanat_no ?? "—"}</td>
                      <td className="p-3 whitespace-nowrap">
                        {shortDate(r.given_date)}
                        {r.expected_return_date && isPending(r) && (
                          <div className={`text-[10px] ${late ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
                            {late ? "overdue " : "due "}{shortDate(r.expected_return_date)}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="font-medium">
                          {p?.account_no && <span className="font-mono text-[11px] text-primary mr-1.5">{p.account_no}</span>}
                          {r.customer_name}
                        </div>
                        {r.phone ? (
                          <a href={`tel:${r.phone}`} onClick={(e) => e.stopPropagation()}
                             className="text-[11px] text-muted-foreground inline-flex items-center gap-1 hover:text-primary">
                            <Phone className="h-3 w-3" /> {r.phone}
                          </a>
                        ) : null}
                        {!p && <div className="text-[10px] text-orange-500">not linked to an account</div>}
                      </td>
                      <td className="p-3">
                        <div className={r.kind === "money" ? "font-semibold" : ""}>{r.kind === "money" ? money(r.amount) : r.item_name}</div>
                        {r.kind === "money" && r.item_name && r.item_name !== "Cash" && <div className="text-[10px] text-muted-foreground">{r.item_name}</div>}
                        {r.notes && <div className="text-[10px] text-muted-foreground truncate max-w-[200px]">{r.notes}</div>}
                      </td>
                      <td className="p-3 font-semibold whitespace-nowrap">
                        {r.kind === "money" ? "—" : r.quantity}
                        {r.kind !== "money" && isPending(r) && out < r.quantity && (
                          <div className="text-[10px] font-normal text-muted-foreground">{out} still out</div>
                        )}
                      </td>
                      <td className="p-3"><DirectionChip direction={r.direction} /></td>
                      <td className="p-3">
                        <StatusChip row={r} today={today} />
                        {!isPending(r) && r.returned_date && <div className="text-[10px] text-muted-foreground mt-0.5">{shortDate(r.returned_date)}</div>}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">Nothing here.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {detail && (
            <AmanatDetail
              row={detail} today={today} products={products}
              onEdit={() => setEditing(detail)}
              onToggle={() => toggleReceived(detail)}
              onDelete={() => remove(detail)}
              onChanged={load}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit amanat {editing?.amanat_no ?? ""}</DialogTitle></DialogHeader>
          {editing && (
            <AmanatForm key={editing.id} partyType={editing.party_type === "merchant" ? "merchant" : "client"} initial={editing}
                        clients={clients} merchants={merchants} products={products}
                        onSaved={() => { setEditing(null); load(); }} onPartyCreated={() => load()} />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function AmanatDetail({ row: r, today, products, onEdit, onToggle, onDelete, onChanged }: {
  row: AmanatRow;
  today: string;
  products: AmanatProduct[];
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const p = partyOf(r);
  const type: AmanatPartyType = r.party_type === "merchant" ? "merchant" : "client";
  const product = r.product_id ? products.find((x) => x.id === r.product_id) ?? null : null;
  const pending = isPending(r);
  const late = isOverdue(r, today);
  const out = outstandingQty(r);
  const [backQty, setBackQty] = useState<number>(Number(r.returned_quantity) || 0);
  useEffect(() => { setBackQty(Number(r.returned_quantity) || 0); }, [r.id, r.returned_quantity]);
  const balance = Number(p?.current_balance) || 0;

  const saveBack = async () => {
    const err = await setAmanatReturnedQty(r, backQty);
    if (err) return toast.error(err);
    toast.success(backQty >= r.quantity ? `All ${r.quantity} back — settled` : `${backQty} of ${r.quantity} back`);
    onChanged();
  };

  return (
    <div className="space-y-4">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 flex-wrap">
          <span className="font-mono">{r.amanat_no ?? "Amanat"}</span>
          <DirectionChip direction={r.direction} />
          <StatusChip row={r} today={today} />
        </SheetTitle>
        <div className="text-xs text-muted-foreground">
          {PARTY_WORD[type]} Amanat · {r.direction === "left" ? "They left with us" : "They took from us"}
        </div>
      </SheetHeader>

      <section className="rounded-xl border p-3 space-y-1.5 text-sm">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{PARTY_WORD[type]}</div>
        {p ? (
          <>
            <div className="font-semibold">
              {p.account_no && <span className="font-mono text-xs text-primary mr-2">{p.account_no}</span>}
              {p.name}
            </div>
            {r.customer_name && r.customer_name !== p.name && (
              <div className="text-xs text-muted-foreground">Recorded as: {r.customer_name}</div>
            )}
          </>
        ) : (
          <>
            <div className="font-semibold">{r.customer_name}</div>
            <div className="text-[11px] text-orange-500">Not linked to an account — use Edit to link it so it shows on their ledger.</div>
          </>
        )}
        <Detail label="Phone">
          {(r.phone || p?.phone)
            ? <a href={`tel:${r.phone || p?.phone}`} className="hover:text-primary">{r.phone || p?.phone}</a>
            : "—"}
        </Detail>
        {p && <Detail label="CNIC">{p.cnic || "—"}</Detail>}
        {p && <Detail label="Address">{p.address || "—"}</Detail>}
        {r.contact && <Detail label="Contact">{r.contact}</Detail>}
        {p && (
          <Detail label="Current balance">
            <span className={balance > 0 ? "text-orange-500 font-semibold" : "text-green-600 font-semibold"}>{money(balance)}</span>
            <span className="text-[10px] text-muted-foreground"> · amanat is not part of the balance</span>
          </Detail>
        )}
      </section>

      <section className="rounded-xl border p-3 space-y-1.5 text-sm">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.kind === "money" ? "Money" : "Item"}</div>
        {r.kind === "money" ? (
          <>
            <div className="text-lg font-black">{money(r.amount)}</div>
            {r.item_name && r.item_name !== "Cash" && <div className="text-xs text-muted-foreground">{r.item_name}</div>}
          </>
        ) : (
          <>
            <div className="font-semibold">{r.item_name} × {r.quantity}</div>
            {pending && out < r.quantity && <Detail label="Back so far">{r.quantity - out} of {r.quantity} · {out} still out</Detail>}
            <Detail label="Product">{r.product_id ? (product ? `${product.product_name} · ${stockLabel(product)}` : "linked product") : "custom item (not a product)"}</Detail>
            <Detail label="Shelf stock">
              {r.direction === "left"
                ? "Their item — not in your stock"
                : r.from_stock
                  ? pending ? `${out} unit${out === 1 ? "" : "s"} off stock until received` : "Taken from stock, given back"
                  : "Not taken from stock"}
            </Detail>
          </>
        )}
      </section>

      <section className="rounded-xl border p-3 text-sm">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Timeline</div>
        <ol className="space-y-2">
          <TimelineStep done label={r.direction === "left" ? "Left with us" : "Given"} date={shortDate(r.given_date)} />
          <TimelineStep
            done={!pending || late}
            danger={late}
            label={late ? "Overdue since" : "Due"}
            date={r.expected_return_date ? shortDate(r.expected_return_date) : "no due date"}
          />
          <TimelineStep done={!pending} label={pending ? "Still pending" : settledWord(r)} date={pending ? "" : shortDate(r.returned_date)} green={!pending} />
        </ol>
      </section>

      {r.notes && (
        <section className="rounded-xl border p-3 text-sm">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Notes</div>
          <div className="whitespace-pre-wrap">{r.notes}</div>
        </section>
      )}

      {pending && r.kind !== "money" && r.quantity > 1 && (
        <section className="rounded-xl border p-3 text-sm space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Part came back</div>
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={r.quantity} value={backQty}
                   onChange={(e) => setBackQty(Number(e.target.value))} className="w-24" />
            <span className="text-xs text-muted-foreground">of {r.quantity} back</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={saveBack}
                    disabled={backQty === (Number(r.returned_quantity) || 0)}>Save</Button>
          </div>
        </section>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" onClick={onEdit}><Pencil className="h-4 w-4 mr-1.5" /> Edit</Button>
        {pending
          ? <Button onClick={onToggle}><PackageCheck className="h-4 w-4 mr-1.5" /> Mark received</Button>
          : <Button variant="outline" onClick={onToggle}><Undo2 className="h-4 w-4 mr-1.5" /> Reopen</Button>}
        <Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4 mr-1.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function TimelineStep({ label, date, done, danger, green }: { label: string; date: string; done?: boolean; danger?: boolean; green?: boolean }) {
  const dot = danger ? "bg-destructive" : green ? "bg-green-600" : done ? "bg-primary" : "bg-muted-foreground/30";
  return (
    <li className="flex items-center gap-2.5">
      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dot}`} />
      <span className={`text-xs ${danger ? "text-destructive font-semibold" : done ? "" : "text-muted-foreground"}`}>{label}</span>
      {date && <span className={`text-xs ml-auto ${danger ? "text-destructive font-semibold" : "text-muted-foreground"}`}>{date}</span>}
    </li>
  );
}

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: LucideIcon; label: string; value: string; sub?: string; tone?: "orange" | "blue" | "red" | "green" }) {
  const color = tone === "orange" ? "text-orange-500" : tone === "blue" ? "text-blue-600" : tone === "red" ? "text-destructive" : tone === "green" ? "text-green-600" : "";
  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</div>
        <Icon className={`h-4 w-4 shrink-0 ${color || "text-primary"}`} />
      </div>
      <div className={`text-xl font-black mt-1 ${color}`}>{value}</div>
      {sub && <div className={`text-xs font-semibold ${color}`}>{sub}</div>}
    </div>
  );
}
