// Tiempo real de borradores: cualquier cambio contable hecho por esta u otra
// sesión llega por Supabase Realtime y refresca la pantalla sin recargar.
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

type Handler = () => void;

/**
 * Escucha los cambios de facturas, renglones y asientos de la empresa activa.
 * El aviso se agrupa (300 ms) para no refrescar una vez por cada fila.
 */
export function useDraftsRealtime(companyId: string | null | undefined, onChange: Handler) {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!companyId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const avisar = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 300);
    };
    const filtro = `company_id=eq.${companyId}`;
    const channel = supabase
      .channel(`borradores-${companyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "invoices", filter: filtro }, avisar)
      .on("postgres_changes", { event: "*", schema: "public", table: "invoice_lines", filter: filtro }, avisar)
      .on("postgres_changes", { event: "*", schema: "public", table: "journal_lines", filter: filtro }, avisar)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [companyId]);
}
