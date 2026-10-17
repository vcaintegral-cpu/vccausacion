import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { evaluarCuenta, partitionSelectableAccounts, type PucAccount } from "@/lib/puc-hierarchy";

export type PucOption = PucAccount;

/** Solo las cuentas de movimiento son seleccionables; las cuentas padre se muestran bloqueadas. */
export function AccountCombobox({
  accounts,
  value,
  onChange,
  placeholder = "Buscar cuenta…",
  className,
}: {
  accounts: PucOption[];
  value?: string | null;
  onChange: (code: string, name: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [aviso, setAviso] = useState<{ code: string; nombre: string; mensaje: string; hijas: PucOption[] } | null>(null);
  const selected = useMemo(() => accounts.find((a) => a.code === value), [accounts, value]);

  const ordenadas = useMemo(() => partitionSelectableAccounts(accounts), [accounts]);
  const visibles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = (account: PucOption) => `${account.code} ${account.name}`.toLocaleLowerCase().includes(query);
    return {
      mov: ordenadas.mov.filter(matches).slice(0, 80),
      padres: ordenadas.padres.filter(matches).slice(0, 80),
    };
  }, [ordenadas, search]);

  const elegir = (a: PucOption) => {
    const evaluacion = evaluarCuenta(accounts, a.code);
    if (!evaluacion.permiteMovimiento) {
      setAviso({
        code: a.code,
        nombre: a.name ?? "",
        mensaje: evaluacion.mensaje ?? "",
        hijas: evaluacion.auxiliares,
      });
      return;
    }
    onChange(a.code, a.name ?? null);
    setAviso(null);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
        if (!o) setAviso(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-9 w-full justify-between px-2 text-left text-xs font-normal", className)}
        >
          <span className="truncate">
            {selected ? `${selected.code} · ${selected.name}` : value ? value : "Seleccionar…"}
          </span>
          <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start">
        {aviso ? (
          <div className="border-b border-border bg-muted/40 p-3">
            <p className="text-xs font-medium text-amber-600">⚠ Esta cuenta requiere auxiliar</p>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">{aviso.code}</span> {aviso.nombre}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{aviso.mensaje}</p>
            <div className="mt-2 max-h-40 space-y-1 overflow-auto">
              {aviso.hijas.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hay auxiliares activas sincronizadas para esta cuenta.</p>
              ) : (
                aviso.hijas.map((h) => (
                  <Button
                    key={h.code}
                    type="button"
                    variant="ghost"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => elegir(h)}
                  >
                    <span className="font-mono">{h.code}</span>
                    <span className="truncate text-muted-foreground">{h.name}</span>
                  </Button>
                ))
              )}
            </div>
          </div>
        ) : null}
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Sin resultados.</CommandEmpty>
            <CommandGroup heading="Cuentas de movimiento">
              {!search.trim() ? <CommandItem
                value="__vacio__ ninguna"
                onSelect={() => {
                  onChange("", null);
                  setOpen(false);
                }}
              >
                <span className="text-muted-foreground">Sin cuenta</span>
              </CommandItem> : null}
              {visibles.mov.map((a) => (
                <CommandItem key={a.code} value={`${a.code} ${a.name}`} onSelect={() => elegir(a)}>
                  <Check className={cn("mr-2 size-3.5", value === a.code ? "opacity-100" : "opacity-0")} />
                  <span className="font-mono">{a.code}</span>
                  <span className="ml-2 truncate text-muted-foreground">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {visibles.padres.length > 0 ? (
              <CommandGroup heading="Cuentas padre (solo consulta)">
                {visibles.padres.map((a) => (
                  <CommandItem
                    key={a.code}
                    value={`${a.code} ${a.name}`}
                    onSelect={() => elegir(a)}
                    className="opacity-60"
                  >
                    <Lock className="mr-2 size-3.5" />
                    <span className="font-mono">{a.code}</span>
                    <span className="ml-2 truncate text-muted-foreground">{a.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
