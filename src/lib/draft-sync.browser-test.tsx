// Browser integration fixture; not imported by application routes.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DraftSyncDialog, type DraftSyncRequest } from "../components/draft-sync-dialog";
import { supabase } from "../integrations/supabase/client";

export function mountSyncCheck(container: HTMLElement, request: DraftSyncRequest) {
  function Check() {
    const [open, setOpen] = useState(true);
    const [rows, setRows] = useState<Array<{ id: string; account_code: string | null; item_type: string | null; code: string | null }>>([]);
    async function readBack() {
      const result = await supabase.from("invoice_lines").select("id, account_code, item_type, code")
        .in("invoice_id", request.drafts.map((d) => d.id)).order("id");
      if (result.error) throw new Error(result.error.message);
      setRows(result.data);
    }
    useEffect(() => { void readBack(); }, []);
    return <>
      <table aria-label="Persisted sync test rows"><tbody>{rows.map((r) => <tr key={r.id} data-line={r.id}>
        <td>{r.account_code ?? "missing"}</td><td>{r.item_type}</td><td>{r.code ?? "no product"}</td>
      </tr>)}</tbody></table>
      <DraftSyncDialog request={open ? request : null} onClose={() => setOpen(false)} onApplied={() => void readBack()} />
    </>;
  }
  const root = createRoot(container);
  root.render(<Check />);
  return () => root.unmount();
}