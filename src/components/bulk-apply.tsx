import { useState, type ReactNode } from "react";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Menú compacto "Aplicar a todos" para el encabezado de una columna de la tabla de renglones. */
export function BulkApply({
  title,
  children,
  className,
}: {
  title: string;
  /** Contenido del menú; recibe una función para cerrarlo al confirmar. */
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Aplicar a todos: ${title}`}
          title={`Aplicar a todos: ${title}`}
          className="ml-1 size-6 text-muted-foreground hover:text-foreground"
        >
          <Layers className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={className ?? "w-72 space-y-2 p-3"}>
        <p className="text-xs font-medium normal-case tracking-normal text-foreground">Aplicar a todos · {title}</p>
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}
