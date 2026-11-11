import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { matchesQuery } from "@/lib/search";

export type SearchableOption = {
  value: string;
  label: string;
  hint?: string;
  /** Kept out of the browse list; shown once the user types (e.g. sold-out products). */
  searchOnly?: boolean;
  /**
   * The bare name the "Add new" check compares a typed name with, when the
   * label carries more (e.g. "CUST-1005 · Ali Khan" → "Ali Khan"). Defaults to the label.
   */
  matchText?: string;
  /**
   * Never offered (e.g. a deleted product); only shown as the current value
   * of an old record. Its name does not block "Add new" — adding it brings
   * the record back.
   */
  hidden?: boolean;
};

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Select with a built-in live search box. Drop-in replacement for the
 * shadcn Select in admin forms where the option list is long (products,
 * merchants, customers, categories, ...).
 */
export function SearchableSelect({
  options, value, onValueChange, placeholder = "Select...", searchPlaceholder = "Type to search...", emptyText = "No match found.", className,
  onCreate, createLabel = "Add", hiddenNoun = "out-of-stock item",
}: {
  options: SearchableOption[];
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  /** When set, typing a name with no exact match shows an "Add ..." row that calls this. */
  onCreate?: (label: string) => void;
  createLabel?: string;
  /** What the search-only options are, for the "N … hidden" footer (singular; an "s" is added). */
  hiddenNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((o) => o.value === value);
  const trimmed = query.trim();
  // Search-only options still count here, so "Add new" is never offered for
  // a name that already exists — typing it shows the existing one. A hidden
  // (deleted) option does not: adding its name brings that record back.
  const canCreate = !!onCreate && trimmed.length > 0 &&
    !options.some((o) => !o.hidden && norm(o.matchText ?? o.label) === norm(trimmed));
  const offered = options.filter((o) => !o.hidden || o.value === value);
  const visible = trimmed ? offered : offered.filter((o) => !o.searchOnly || o.value === value);
  const hiddenCount = offered.length - visible.length;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command
          filter={(itemValue, search) => (matchesQuery(itemValue, search) ? 1 : 0)}
        >
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-60">
            <CommandEmpty>
              {canCreate ? (
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-md text-left"
                  onClick={() => { onCreate!(trimmed); setQuery(""); setOpen(false); }}
                >
                  <Plus className="h-4 w-4 text-primary" /> {createLabel} “{trimmed}”
                </button>
              ) : emptyText}
            </CommandEmpty>
            <CommandGroup>
              {visible.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ""}`}
                  onSelect={() => { onValueChange(o.value); setQuery(""); setOpen(false); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === o.value ? "opacity-100" : "opacity-0")} />
                  <div className="min-w-0">
                    <div className="truncate">{o.label}</div>
                    {o.hint && <div className="text-xs text-muted-foreground truncate">{o.hint}</div>}
                  </div>
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem value={`__create__ ${trimmed}`} onSelect={() => { onCreate!(trimmed); setQuery(""); setOpen(false); }}>
                  <Plus className="mr-2 h-4 w-4 text-primary" />
                  <span>{createLabel} “{trimmed}”</span>
                </CommandItem>
              )}
            </CommandGroup>
            {hiddenCount > 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground border-t">
                {hiddenCount} {hiddenNoun}{hiddenCount === 1 ? "" : "s"} hidden — type a name to find {hiddenCount === 1 ? "it" : "them"}
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
