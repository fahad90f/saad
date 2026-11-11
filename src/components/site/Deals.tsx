import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { money } from "@/lib/format";
import { inStock, isTracked } from "@/lib/stock";

function useCountdown(target: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (target == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  const diff = target == null ? 0 : Math.max(0, target - now);
  const s = Math.floor(diff / 1000);
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

type Deal = {
  id: string; product_name: string; image_url: string | null;
  selling_price: number | null; quantity_in_stock: number | null; track_stock: boolean | null;
  deal_end_date: string | null;
};

/** Website rule: tracked, units on hand and priced — a deal nobody can buy is not shown. */
const showable = (p: Deal) => isTracked(p) && inStock(p) && Number(p.selling_price) > 0;

/**
 * "Deal of the day" products — whatever the admin ticks as a deal on the
 * Products page (with an optional end date). The countdown runs to the
 * soonest-ending deal.
 */
export function Deals() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("products")
        .select("id, product_name, image_url, selling_price, quantity_in_stock, track_stock, deal_end_date")
        .eq("is_deal", true)
        .eq("track_stock", true).gt("quantity_in_stock", 0).gt("selling_price", 0)
        .is("deleted_at", null)
        // Expired deals stay ticked until the admin unticks them; keep them
        // out of the query so they can't crowd live deals out of the limit.
        .or(`deal_end_date.is.null,deal_end_date.gt.${new Date().toISOString()}`)
        .order("deal_end_date", { ascending: true, nullsFirst: false })
        .limit(10);
      const now = Date.now();
      setDeals((data ?? []).filter((p) => showable(p) && (!p.deal_end_date || new Date(p.deal_end_date).getTime() > now)));
    })();
  }, []);

  const soonest = deals?.find((p) => p.deal_end_date)?.deal_end_date ?? null;
  const target = soonest ? new Date(soonest).getTime() : null;
  const { d, h, m, s } = useCountdown(target);

  return (
    <section className="px-4 mt-10">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h2 className="text-2xl font-bold">
          Day Of The <span className="text-primary">Deals</span>
        </h2>
        {target != null && (
          <div className="flex items-center gap-2 rounded-full bg-card shadow-sm px-4 py-2 text-sm">
            <Pill label="Days" v={d} />
            <span>:</span>
            <Pill v={h} />
            <span>:</span>
            <Pill v={m} />
            <span>:</span>
            <Pill v={s} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {deals === null && [...Array(5)].map((_, i) => (
          <div key={i} className="rounded-2xl bg-card shadow-sm h-56 animate-pulse" />
        ))}
        {deals !== null && deals.length === 0 && (
          <div className="col-span-full rounded-2xl bg-card shadow-sm p-8 text-center text-sm text-muted-foreground">
            No deals available right now — check back soon.
          </div>
        )}
        {deals?.map((p) => (
          <Link key={p.id} to="/product/$id" params={{ id: p.id }}
                className="block rounded-2xl bg-card shadow-sm overflow-hidden hover:-translate-y-1 hover:shadow-md transition-all">
            <div className="aspect-square bg-muted">
              {p.image_url && <img src={p.image_url} alt={p.product_name} className="h-full w-full object-cover" loading="lazy" />}
            </div>
            <div className="p-3">
              <div className="font-semibold truncate">{p.product_name}</div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-primary font-bold">{money(p.selling_price)}</span>
                <span className={`text-[11px] ${inStock(p) ? "text-green-600" : "text-destructive"}`}>
                  {inStock(p) ? "In stock" : "Out of stock"}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Pill({ v, label }: { v: number; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold">
      <span className="text-gold">{String(v).padStart(2, "0")}</span>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </span>
  );
}
