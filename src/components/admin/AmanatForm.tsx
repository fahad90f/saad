// Amanat (things held in trust) — shared by the Amanat page and the
// customer / merchant ledgers (PartyManager).
//
// Seen from the shop:
//   Taken    — the party took our item / money (it is with them)
//   Left     — the party left their item / money with us (we hold it)
//   Pending  — still open
//   Received — settled ("Received back" for taken, "Handed back" for left)
//
// Amanat never touches the account ledgers: money held in trust is shown
// beside the balance, not in it. An item taken "from shelf stock" is booked
// in the stock ledger by the database (amanat_stock_sync trigger, migration
// 20261020): it comes off stock when given and goes back when returned,
// received or deleted, each change as its own dated stock movement. Items a
// party left with us are not ours and never add to stock.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { localToday, money } from "@/lib/format";
import { inStockFirst } from "@/lib/pricing";
import { isTracked, productOption, stockOf } from "@/lib/stock";
import { confirmStockForSale } from "@/lib/products";
import { fetchAll } from "@/lib/fetchAll";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/admin/SearchableSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { Plus, Save } from "lucide-react";

export type AmanatPartyType = "client" | "merchant";
export type AmanatDirection = "taken" | "left";
export type AmanatKind = "item" | "money";

export type AmanatParty = {
  id: string;
  name: string | null;
  account_no: string | null;
  phone: string | null;
  address?: string | null;
  cnic?: string | null;
  current_balance?: number | null;
};

export type AmanatRow = {
  id: string;
  amanat_no: string | null;
  party_type: string;
  client_id: string | null;
  merchant_id: string | null;
  customer_name: string;
  phone: string | null;
  contact: string | null;
  direction: string;
  kind: string;
  amount: number | null;
  product_id: string | null;
  item_name: string;
  quantity: number;
  from_stock: boolean;
  given_date: string;
  expected_return_date: string | null;
  status: string;
  returned_date: string | null;
  returned_quantity: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  clients?: AmanatParty | null;
  merchants?: AmanatParty | null;
};

export type AmanatProduct = {
  id: string;
  product_name: string | null;
  quantity_in_stock: number | null;
  track_stock: boolean | null;
  /** Set when deleted on the Products page: never offered for a new entry. */
  deleted_at?: string | null;
};

/** Party columns loaded for pickers and the detail views. */
export const PARTY_COLUMNS = "id, name, account_no, phone, address, cnic, current_balance";
/** amanat_items with the linked customer / merchant profile embedded. */
export const AMANAT_SELECT =
  "*, clients(id, name, account_no, phone, address, cnic, current_balance), merchants(id, name, account_no, phone, address, cnic, current_balance)";

export const PARTY_TABLE: Record<AmanatPartyType, "clients" | "merchants"> = { client: "clients", merchant: "merchants" };
export const PARTY_WORD: Record<AmanatPartyType, string> = { client: "Customer", merchant: "Merchant" };
export const DIRECTION_TEXT: Record<AmanatDirection, string> = {
  taken: "They took from us",
  left: "They left with us",
};

// ---------------------------------------------------------------- helpers

export const isPending = (r: Pick<AmanatRow, "status">) => r.status !== "received";
export const isOverdue = (r: Pick<AmanatRow, "status" | "expected_return_date">, today: string) =>
  isPending(r) && !!r.expected_return_date && r.expected_return_date < today;
/** Units still out (pending rows); 0 once received. */
export const outstandingQty = (r: Pick<AmanatRow, "status" | "quantity" | "returned_quantity">) =>
  isPending(r) ? Math.max(0, Number(r.quantity) - Math.max(0, Number(r.returned_quantity) || 0)) : 0;
/** "Battery N70 × 2" or "Rs 5,000". */
export const amanatWhat = (r: Pick<AmanatRow, "kind" | "amount" | "item_name" | "quantity">) =>
  r.kind === "money" ? money(r.amount) : `${r.item_name} × ${r.quantity}`;
export const settledWord = (r: Pick<AmanatRow, "direction">) => (r.direction === "left" ? "Handed back" : "Received back");
/** The linked customer / merchant profile, whichever this entry belongs to. */
export const partyOf = (r: AmanatRow): AmanatParty | null =>
  (r.party_type === "merchant" ? r.merchants : r.clients) ?? null;

/** Pending totals for one direction: units still out, cash, entries. */
export function amanatTotals(rows: AmanatRow[], direction: AmanatDirection) {
  const open = rows.filter((r) => isPending(r) && r.direction === direction);
  return {
    count: open.length,
    items: open.filter((r) => r.kind !== "money").reduce((a, r) => a + outstandingQty(r), 0),
    rs: open.filter((r) => r.kind === "money").reduce((a, r) => a + (Number(r.amount) || 0), 0),
  };
}
export const totalsText = (t: { items: number; rs: number }) => `${money(t.rs)} / ${t.items} item${t.items === 1 ? "" : "s"}`;

export function DirectionChip({ direction, className }: { direction: string; className?: string }) {
  const left = direction === "left";
  return (
    <span className={cn(
      "inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 border whitespace-nowrap",
      left ? "border-blue-500/40 text-blue-600" : "border-orange-500/40 text-orange-500",
      className,
    )}>
      {left ? "Left" : "Taken"}
    </span>
  );
}

export function StatusChip({ row, today, className }: { row: Pick<AmanatRow, "status" | "direction" | "expected_return_date">; today: string; className?: string }) {
  const received = !isPending(row);
  const overdue = isOverdue(row, today);
  const tone = received
    ? "bg-green-600/10 text-green-600"
    : overdue
      ? "bg-destructive/10 text-destructive"
      : row.direction === "left" ? "bg-blue-500/10 text-blue-600" : "bg-orange-500/10 text-orange-500";
  return (
    <span className={cn("inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap", tone, className)}>
      {received ? "Received" : overdue ? "Overdue" : "Pending"}
    </span>
  );
}

// ---------------------------------------------------------------- actions (return an error message or null)

export async function setAmanatReceived(r: Pick<AmanatRow, "id" | "quantity">, received: boolean) {
  const { error } = await supabase.from("amanat_items").update(received
    ? { status: "received", returned_date: localToday(), returned_quantity: Number(r.quantity), updated_at: new Date().toISOString() }
    : { status: "pending", returned_date: null, returned_quantity: 0, updated_at: new Date().toISOString() },
  ).eq("id", r.id);
  return error?.message ?? null;
}

/** Part of the units came back; all of them back settles the entry. */
export async function setAmanatReturnedQty(r: Pick<AmanatRow, "id" | "quantity">, qty: number) {
  const n = Math.max(0, Math.min(Math.floor(qty) || 0, Number(r.quantity)));
  const all = n >= Number(r.quantity);
  const { error } = await supabase.from("amanat_items").update({
    returned_quantity: n,
    status: all ? "received" : "pending",
    returned_date: all || n > 0 ? localToday() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", r.id);
  return error?.message ?? null;
}

export async function deleteAmanat(id: string) {
  const { error } = await supabase.from("amanat_items").delete().eq("id", id);
  return error?.message ?? null;
}

const contactOf = (p: AmanatParty | null | undefined) =>
  [p?.address, p?.cnic ? `CNIC ${p.cnic}` : null].filter(Boolean).join(" · ");
const partyLabel = (p: AmanatParty) => `${p.account_no ? `${p.account_no} · ` : ""}${p.name ?? "—"}`;
const normName = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The customer / merchant already carrying this name (case and spacing
 * ignored): the loaded list first, then the database (an account added on
 * another device). The database is asked for a loose ILIKE match — only
 * letters/digits go into the pattern, so nothing needs LIKE-escaping — and
 * the exact comparison happens here.
 */
async function findPartyByName(type: AmanatPartyType, name: string, list: AmanatParty[]) {
  const want = normName(name);
  if (!want) return { party: null, error: null };
  const local = list.find((p) => normName(p.name) === want);
  if (local) return { party: local, error: null };
  const words = want.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return { party: null, error: null };
  const { data, error } = await supabase.from(PARTY_TABLE[type]).select(PARTY_COLUMNS)
    .ilike("name", `%${words.join("%")}%`).limit(200);
  if (error) return { party: null, error: error.message };
  return { party: ((data ?? []) as AmanatParty[]).find((p) => normName(p.name) === want) ?? null, error: null };
}

// ---------------------------------------------------------------- form

type FormState = {
  party_id: string;
  customer_name: string;
  phone: string;
  contact: string;
  direction: AmanatDirection;
  kind: AmanatKind;
  amount: string;
  product_id: string;
  item_name: string;
  quantity: number;
  from_stock: boolean;
  given_date: string;
  expected_return_date: string;
  notes: string;
};

const blankForm = (type: AmanatPartyType, party?: AmanatParty | null, given = localToday()): FormState => ({
  party_id: party?.id ?? "",
  customer_name: party?.name ?? "",
  phone: party?.phone ?? "",
  contact: contactOf(party),
  direction: "taken",
  kind: "item",
  amount: "",
  product_id: "",
  item_name: "",
  quantity: 1,
  // Shelf stock: on by default for customers (we lend our item), off for
  // merchants (usually a claim / replacement that is not shop stock).
  from_stock: type === "client",
  given_date: given,
  expected_return_date: "",
  notes: "",
});

const formFromRow = (r: AmanatRow): FormState => ({
  party_id: (r.party_type === "merchant" ? r.merchant_id : r.client_id) ?? "",
  customer_name: r.customer_name ?? "",
  phone: r.phone ?? "",
  contact: r.contact ?? "",
  direction: r.direction === "left" ? "left" : "taken",
  kind: r.kind === "money" ? "money" : "item",
  amount: r.amount != null ? String(r.amount) : "",
  product_id: r.product_id ?? "",
  item_name: r.item_name ?? "",
  quantity: Number(r.quantity) || 1,
  from_stock: !!r.from_stock,
  given_date: r.given_date ?? localToday(),
  expected_return_date: r.expected_return_date ?? "",
  notes: r.notes ?? "",
});

/**
 * New / edit form for one amanat entry. `fixedParty` locks it to one
 * customer or merchant (the ledger's "Add amanat"); otherwise a party picker
 * bound to `partyType` is shown (required for new entries; typing a new
 * name creates the account). With `initial` it edits that entry and lets the
 * owner re-classify it (customer/merchant, party, direction, item/money).
 * Lists not passed in are loaded by the form itself.
 */
export function AmanatForm({
  partyType: partyTypeProp, fixedParty, clients, merchants, products, initial, onSaved, onPartyCreated,
}: {
  partyType: AmanatPartyType;
  fixedParty?: AmanatParty | null;
  clients?: AmanatParty[];
  merchants?: AmanatParty[];
  products?: AmanatProduct[];
  initial?: AmanatRow | null;
  onSaved: (row: AmanatRow | null) => void;
  onPartyCreated?: (party: AmanatParty, type: AmanatPartyType) => void;
}) {
  const editing = !!initial;
  const [partyType, setPartyType] = useState<AmanatPartyType>(
    initial ? (initial.party_type === "merchant" ? "merchant" : "client") : partyTypeProp,
  );
  const [form, setForm] = useState<FormState>(() => (initial ? formFromRow(initial) : blankForm(partyTypeProp, fixedParty)));
  const [saving, setSaving] = useState(false);
  const [ownProducts, setOwnProducts] = useState<AmanatProduct[]>([]);
  const [ownParties, setOwnParties] = useState<Record<AmanatPartyType, AmanatParty[]>>({ client: [], merchant: [] });
  const [createdParties, setCreatedParties] = useState<Record<AmanatPartyType, AmanatParty[]>>({ client: [], merchant: [] });

  useEffect(() => {
    if (!products) {
      fetchAll((a, b) => supabase.from("products").select("id, product_name, quantity_in_stock, track_stock, deleted_at")
        .order("product_name").order("id").range(a, b))
        .then(({ data }) => setOwnProducts(data as AmanatProduct[]));
    }
    if (!fixedParty && (!clients || !merchants)) {
      Promise.all([
        fetchAll((a, b) => supabase.from("clients").select(PARTY_COLUMNS).order("name").order("id").range(a, b)),
        fetchAll((a, b) => supabase.from("merchants").select(PARTY_COLUMNS).order("name").order("id").range(a, b)),
      ]).then(([c, m]) => setOwnParties({ client: c.data as AmanatParty[], merchant: m.data as AmanatParty[] }));
    }
    // load once per mount; the parent passes fresh lists when it has them
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const productList = products ?? ownProducts;
  const partyList = useMemo(() => {
    const base = (partyType === "client" ? clients : merchants) ?? ownParties[partyType];
    const extra = createdParties[partyType].filter((p) => !base.some((b) => b.id === p.id));
    return [...base, ...extra];
  }, [partyType, clients, merchants, ownParties, createdParties]);

  const product = productList.find((p) => p.id === form.product_id) ?? null;
  // Only our own tracked product, going out to the party, can come off the shelf.
  const stockable = form.kind === "item" && form.direction === "taken" && !!product && isTracked(product);
  const fromStock = stockable && form.from_stock;
  const word = PARTY_WORD[partyType].toLowerCase();

  const pickParty = (id: string) => {
    const p = partyList.find((x) => x.id === id);
    setForm({ ...form, party_id: id, customer_name: p?.name ?? form.customer_name, phone: p?.phone ?? "", contact: contactOf(p) });
  };

  const createParty = async (name: string) => {
    // A name that already has an account picks that account instead of
    // opening a duplicate one.
    const found = await findPartyByName(partyType, name, partyList);
    if (found.error) return toast.error(found.error);
    if (found.party) {
      const p = found.party;
      if (!partyList.some((x) => x.id === p.id)) {
        setCreatedParties((prev) => ({ ...prev, [partyType]: [...prev[partyType], p] }));
      }
      setForm((f) => ({ ...f, party_id: p.id, customer_name: p.name ?? f.customer_name, phone: p.phone ?? "", contact: contactOf(p) }));
      toast.info(`${p.name} already has ${word} account ${p.account_no ?? ""} — selected it`);
      return;
    }
    const { data, error } = await supabase.from(PARTY_TABLE[partyType])
      .insert({ name: name.trim(), phone: form.phone.trim() || null })
      .select(PARTY_COLUMNS).maybeSingle();
    if (error || !data) return toast.error(error?.message ?? `Could not add the ${word}`);
    const p = data as AmanatParty;
    setCreatedParties((prev) => ({ ...prev, [partyType]: [...prev[partyType], p] }));
    setForm((f) => ({ ...f, party_id: p.id, customer_name: p.name ?? name, phone: p.phone ?? f.phone, contact: contactOf(p) }));
    toast.success(`${PARTY_WORD[partyType]} account ${p.account_no ?? ""} created for ${p.name}`);
    onPartyCreated?.(p, partyType);
  };

  const switchPartyType = (t: AmanatPartyType) => {
    if (t === partyType) return;
    setPartyType(t);
    setForm((f) => ({ ...f, party_id: "" }));
  };

  const save = async () => {
    const partyId = fixedParty?.id ?? (form.party_id || null);
    if (!editing && !partyId) return toast.error(`Pick the ${word} — or type a new name to add the account`);
    const name = form.customer_name.trim();
    if (!name) return toast.error("Name required");

    let itemName = form.item_name.trim();
    let qty = Math.floor(Number(form.quantity));
    let amount: number | null = null;
    if (form.kind === "money") {
      amount = Number(form.amount);
      if (!(amount > 0)) return toast.error("Enter the amount");
      itemName = itemName || "Cash";
      qty = 1;
    } else {
      if (!itemName) return toast.error("Pick a product or type the item");
      if (!(qty >= 1)) return toast.error("Quantity must be at least 1");
    }

    // Warn before taking more units off the shelf than are on hand — only the
    // units this save newly takes out count (an edit keeps what is already out).
    if (fromStock) {
      const returned = initial ? Math.min(Number(initial.returned_quantity) || 0, qty) : 0;
      const willBeOut = initial && !isPending(initial) ? 0 : qty - returned;
      const alreadyOut = initial && initial.from_stock && initial.kind === "item" && initial.direction === "taken"
        && initial.product_id === form.product_id ? outstandingQty(initial) : 0;
      const extra = willBeOut - alreadyOut;
      if (extra > 0 && !(await confirmStockForSale([{ product_id: form.product_id, qty: extra }]))) return;
    }

    const payload = {
      party_type: partyType,
      client_id: partyType === "client" ? partyId : null,
      merchant_id: partyType === "merchant" ? partyId : null,
      customer_name: name,
      phone: form.phone.trim() || null,
      contact: form.contact.trim() || null,
      direction: form.direction,
      kind: form.kind,
      amount,
      product_id: form.kind === "item" ? (form.product_id || null) : null,
      item_name: itemName,
      quantity: qty,
      from_stock: fromStock,
      given_date: form.given_date || localToday(),
      expected_return_date: form.expected_return_date || null,
      notes: form.notes.trim() || null,
    };

    setSaving(true);
    try {
      const { data, error } = initial
        ? await supabase.from("amanat_items").update({
            ...payload,
            returned_quantity: isPending(initial) ? Math.min(Number(initial.returned_quantity) || 0, qty) : qty,
            updated_at: new Date().toISOString(),
          }).eq("id", initial.id).select(AMANAT_SELECT).maybeSingle()
        : await supabase.from("amanat_items").insert({ ...payload, status: "pending" }).select(AMANAT_SELECT).maybeSingle();
      if (error) return toast.error(error.message);
      const row = (data ?? null) as unknown as AmanatRow | null;
      const what = form.kind === "money" ? money(amount) : `${itemName} × ${qty}`;
      toast.success(initial
        ? `Amanat ${initial.amanat_no ?? ""} updated`
        : `Amanat ${row?.amanat_no ?? ""} recorded — ${what} (${form.direction === "taken" ? "taken by" : "left by"} ${name})`);
      if (!initial) setForm(blankForm(partyType, fixedParty, form.given_date));
      onSaved(row);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {editing && !fixedParty && (
        <div className="space-y-1.5">
          <Label>Belongs to</Label>
          <Segmented value={partyType} onChange={switchPartyType}
                     options={[{ value: "client", label: "Customer" }, { value: "merchant", label: "Merchant" }]} />
        </div>
      )}

      {fixedParty ? (
        <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
          <span className="text-muted-foreground">{PARTY_WORD[partyType]}: </span>
          <b>{partyLabel(fixedParty)}</b>
          {fixedParty.phone ? <span className="text-muted-foreground"> · {fixedParty.phone}</span> : null}
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>{PARTY_WORD[partyType]} account {!editing && <span className="text-destructive">*</span>}</Label>
          <SearchableSelect
            options={partyList.map((p) => ({ value: p.id, label: partyLabel(p), matchText: p.name ?? undefined, hint: p.phone ?? undefined }))}
            value={form.party_id}
            onValueChange={pickParty}
            placeholder={`Select ${word}`}
            searchPlaceholder="Search by ID, name, phone..."
            onCreate={createParty}
            createLabel={`Add new ${word}`}
          />
          {editing && !form.party_id && (
            <div className="text-[11px] text-orange-500">Not linked to an account yet — pick one so it shows on their ledger.</div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5 col-span-2 sm:col-span-1"><Label>Name <span className="text-destructive">*</span></Label>
          <Input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} placeholder="Person's name" />
        </div>
        <div className="space-y-1.5 col-span-2 sm:col-span-1"><Label>Phone</Label>
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="03xx-xxxxxxx" />
        </div>
      </div>
      <div className="space-y-1.5"><Label>Other contact details <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="Address, CNIC, who brought it..." />
      </div>

      <div className="space-y-1.5">
        <Label>What happened?</Label>
        <RadioGroup value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v as AmanatDirection })} className="grid-cols-2">
          {(["taken", "left"] as const).map((d) => (
            <label key={d} className={cn(
              "flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer text-sm",
              form.direction === d && (d === "left" ? "border-blue-500/60 bg-blue-500/5" : "border-orange-500/60 bg-orange-500/5"),
            )}>
              <RadioGroupItem value={d} className="mt-0.5" />
              <span className="leading-tight">
                <span className="block font-medium">{DIRECTION_TEXT[d]}</span>
                <span className="block text-[11px] text-muted-foreground">{d === "taken" ? "ours, now with them" : "theirs, we are holding it"}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>

      <Segmented value={form.kind} onChange={(k) => setForm({ ...form, kind: k })}
                 options={[{ value: "item", label: "Item" }, { value: "money", label: "Money" }]} />

      {form.kind === "money" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5"><Label>Amount (Rs) <span className="text-destructive">*</span></Label>
            <Input type="number" step="any" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="space-y-1.5"><Label>Description</Label>
            <Input value={form.item_name} onChange={(e) => setForm({ ...form, item_name: e.target.value })} placeholder="Cash" />
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-1.5"><Label>Item <span className="text-destructive">*</span></Label>
            <SearchableSelect
              options={inStockFirst(productList).map((p) => productOption(p))}
              value={form.product_id}
              onValueChange={(v) => {
                const p = productList.find((x) => x.id === v);
                setForm({ ...form, product_id: v, item_name: p?.product_name ?? form.item_name });
              }}
              placeholder={form.item_name || "Select product or type any item"}
              searchPlaceholder="Search or type any item name..."
              onCreate={(name) => setForm({ ...form, product_id: "", item_name: name })}
              createLabel="Use custom item"
            />
            {form.item_name && (
              <div className="text-[11px] text-muted-foreground">
                Item: <b className="text-foreground">{form.item_name}</b>{!form.product_id && " (custom, not a product)"}
              </div>
            )}
          </div>
          <div className="space-y-1.5"><Label>Quantity</Label>
            <Input type="number" min={1} value={form.quantity || ""} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
          </div>
          {stockable ? (
            <label className="flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer">
              <Checkbox checked={form.from_stock} onCheckedChange={(c) => setForm({ ...form, from_stock: c === true })} className="mt-0.5" />
              <span className="text-sm leading-tight">
                <span className="block font-medium">Take from shelf stock</span>
                <span className="block text-[11px] text-muted-foreground">
                  {form.from_stock
                    ? `${stockOf(product!)} on hand now — comes off stock, goes back when received.`
                    : "Shelf stock stays as it is."}
                </span>
              </span>
            </label>
          ) : form.direction === "left" ? (
            <div className="text-[11px] text-muted-foreground">Their item — it is never added to your stock.</div>
          ) : null}
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5"><Label>Date</Label>
          <Input type="date" value={form.given_date} onChange={(e) => setForm({ ...form, given_date: e.target.value })} />
        </div>
        <div className="space-y-1.5"><Label>{form.direction === "left" ? "Hand back by" : "Return by"} <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input type="date" value={form.expected_return_date} onChange={(e) => setForm({ ...form, expected_return_date: e.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5"><Label>Notes</Label>
        <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder={form.direction === "left" ? "Claim battery left for checking..." : "Old battery ke badle, wapas karega..."} />
      </div>

      <Button className="w-full" onClick={save} disabled={saving}>
        {saving ? "Saving..." : editing
          ? <><Save className="h-4 w-4 mr-2" /> Save changes</>
          : <><Plus className="h-4 w-4 mr-2" /> Record amanat</>}
      </Button>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
                className={cn("rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  value === o.value ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
