import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { SiteShell } from "@/components/site/SiteShell";
import { money } from "@/lib/format";
import { inStock, isTracked } from "@/lib/stock";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { COMPANY } from "@/lib/company";
import { fetchAll } from "@/lib/fetchAll";

export const Route = createFileRoute("/shop")({
  head: () => ({
    meta: [
      { title: `Shop — ${COMPANY.name}` },
      { name: "description", content: "Browse tyres, batteries, tubes and car care products." },
    ],
  }),
  component: Shop,
});

type Product = {
  id: string; product_name: string; image_url: string | null;
  selling_price: number; quantity_in_stock: number; track_stock: boolean;
  category_id: string | null; brand_id: string | null;
  created_at: string | null;
};

/**
 * What the website may show: a stock-tracked product with units on hand
 * and a selling price. Services/trade-ins (not tracked), anything out of
 * stock and unpriced products never appear on the shop. The query already
 * filters on these; the guard also runs here so a stale row can't slip in.
 */
const showable = (p: Product) => isTracked(p) && inStock(p) && Number(p.selling_price) > 0;

function Shop() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [brand, setBrand] = useState<string>("all");

  useEffect(() => {
    (async () => {
      const [{ data: p }, { data: c }, { data: b }] = await Promise.all([
        fetchAll((a, b) => supabase.from("products").select("*")
          .eq("track_stock", true).gt("quantity_in_stock", 0).gt("selling_price", 0)
          .is("deleted_at", null)
          .order("created_at", { ascending: false }).order("id").range(a, b)),
        supabase.from("categories").select("id, name").order("display_order"),
        supabase.from("brands").select("id, name").order("name"),
      ]);
      setProducts(p ?? []);
      setCats(c ?? []);
      setBrands(b ?? []);
    })();
  }, []);

  // Only sellable products are listed (see `showable`); newest first, the
  // order this catalog always used.
  const filtered = (products ?? [])
    .filter((p) =>
      showable(p) &&
      (cat === "all" || p.category_id === cat) &&
      (brand === "all" || p.brand_id === brand) &&
      (q === "" || p.product_name.toLowerCase().includes(q.toLowerCase()))
    )
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  return (
    <SiteShell>
      <div className="px-4 pt-6">
        <h1 className="text-3xl font-black">Shop</h1>
        <p className="text-muted-foreground text-sm mt-1">Browse our full catalog.</p>

        <div className="mt-6 flex flex-wrap gap-3 items-center">
          <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search products..." value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={cat} onValueChange={setCat}>
            <SelectTrigger className="flex-1 sm:flex-none sm:w-[200px]"><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={brand} onValueChange={setBrand}>
            <SelectTrigger className="flex-1 sm:flex-none sm:w-[180px]"><SelectValue placeholder="Brand" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All brands</SelectItem>
              {brands.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {products === null && [...Array(8)].map((_, i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}
          {products !== null && filtered.length === 0 && (
            <div className="col-span-full rounded-2xl bg-card p-16 text-center text-muted-foreground">
              No products match your filters.
            </div>
          )}
          {filtered.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (i % 8) * 0.05 }}
            >
              <Link
                to="/product/$id" params={{ id: p.id }}
                className="block rounded-2xl bg-card shadow-sm overflow-hidden hover:-translate-y-1 hover:shadow-md transition-all"
              >
                <div className="aspect-square bg-muted">
                  {p.image_url && <img src={p.image_url} alt={p.product_name} className="h-full w-full object-cover" loading="lazy" />}
                </div>
                <div className="p-4">
                  <div className="font-semibold truncate">{p.product_name}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-primary font-bold">{money(p.selling_price)}</span>
                    <span className={`text-xs ${inStock(p) ? "text-green-600" : "text-destructive"}`}>
                      {inStock(p) ? "In stock" : "Out of stock"}
                    </span>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
