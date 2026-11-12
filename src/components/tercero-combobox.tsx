// Selector de tercero por NIT o por nombre (terceros de la empresa sincronizados de Siigo).
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type TerceroOption = { nit: string; name: string };

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const soloDigitos = (s: string) => s.replace(/\D/g, "");

export function TerceroCombobox({
  terceros,
  value,
  onChange,
  className,
}: {
  terceros: TerceroOption[];
  value: string;
  onChange: (nit: string, nombre: string | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const seleccionado = useMemo(
    () => terceros.find((t) => soloDigitos(t.nit) === soloDigitos(value)),
    [terceros, value],
  );
  const visibles = useMemo(() => {
    const q = sinTildes(search.trim());
    if (!q) return terceros.slice(0, 60);
    const qDig = soloDigitos(q);
    return terceros
      .filter(
        (t) =>
          (qDig.length >= 3 && soloDigitos(t.nit).includes(qDig)) || sinTildes(t.name).includes(q),
      )
      .slice(0, 80);
  }, [terceros, search]);
  const nitEscrito = soloDigitos(search);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-7 w-full justify-between px-2 text-left text-xs font-normal", className)}
        >
          <span className="truncate">
            {seleccionado
              ? `${seleccionado.nit} · ${seleccionado.name}`
              : value || "Buscar por NIT o nombre…"}
          </span>
          <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="NIT o nombre del tercero…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>Sin resultados.</CommandEmpty>
            <CommandGroup heading="Terceros">
              {nitEscrito.length >= 5 &&
              !terceros.some((t) => soloDigitos(t.nit) === nitEscrito) ? (
                <CommandItem
                  value={`__nit__ ${nitEscrito}`}
                  onSelect={() => {
                    onChange(nitEscrito, null);
                    setOpen(false);
                  }}
                >
                  <span>
                    Usar el NIT <b>{nitEscrito}</b> (no está en los terceros sincronizados)
                  </span>
                </CommandItem>
              ) : null}
              {visibles.map((t) => (
                <CommandItem
                  key={t.nit}
                  value={`${t.nit} ${t.name}`}
                  onSelect={() => {
                    onChange(soloDigitos(t.nit), t.name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 size-3.5",
                      seleccionado?.nit === t.nit ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="font-mono">{t.nit}</span>
                  <span className="ml-2 truncate text-muted-foreground">{t.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
