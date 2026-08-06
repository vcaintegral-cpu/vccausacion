import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type PucOption = { code: string; name: string };

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
  const selected = useMemo(() => accounts.find((a) => a.code === value), [accounts, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>Sin resultados.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__vacio__ ninguna"
                onSelect={() => {
                  onChange("", null);
                  setOpen(false);
                }}
              >
                <span className="text-muted-foreground">Sin cuenta</span>
              </CommandItem>
              {accounts.map((a) => (
                <CommandItem
                  key={a.code}
                  value={`${a.code} ${a.name}`}
                  onSelect={() => {
                    onChange(a.code, a.name ?? null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 size-3.5", value === a.code ? "opacity-100" : "opacity-0")} />
                  <span className="font-mono">{a.code}</span>
                  <span className="ml-2 truncate text-muted-foreground">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
