import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type ProductOption = {
  code: string;
  name: string;
  kind: string;
  category?: string | null;
  account_code?: string | null;
  account_name?: string | null;
};

/** Buscador de productos o servicios por nombre o código. */
export function ProductCombobox({
  products,
  kind,
  value,
  onSelect,
  className,
}: {
  products: ProductOption[];
  /** Filtra el catálogo por tipo (producto | servicio). */
  kind?: string;
  value?: string | null;
  onSelect: (product: ProductOption) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => (kind ? products.filter((p) => p.kind === kind) : products),
    [products, kind],
  );
  const selected = useMemo(() => options.find((p) => p.code === value), [options, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-8 w-full justify-between px-2 text-left text-xs font-normal", className)}
        >
          <span className="truncate">
            {selected ? `${selected.code} · ${selected.name}` : `Buscar ${kind === "servicio" ? "servicio" : "producto"}…`}
          </span>
          <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start">
        <Command filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder="Buscar por nombre o código…" />
          <CommandList>
            <CommandEmpty>Sin resultados en el catálogo.</CommandEmpty>
            <CommandGroup>
              {options.map((p) => (
                <CommandItem
                  key={p.code}
                  value={`${p.code} ${p.name} ${p.category ?? ""}`}
                  onSelect={() => {
                    onSelect(p);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 size-3.5", value === p.code ? "opacity-100" : "opacity-0")} />
                  <span className="font-mono">{p.code}</span>
                  <span className="ml-2 truncate">{p.name}</span>
                  {p.category && <span className="ml-2 truncate text-muted-foreground">{p.category}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
