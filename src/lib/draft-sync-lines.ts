import { isValidPurchaseAccount } from "./provider-rules";
import { buscarProducto, type ProductoCatalogo } from "./producto-coincidencia";
import type { SyncChange } from "./draft-sync";

export type SyncLine = {
  id: string;
  position: number;
  account_code: string | null;
  account_name: string | null;
  item_type: string | null;
  code: string | null;
  description: string | null;
};

/** A proposal only: the transaction rechecks scope, eligibility and current state before writing. */
export function planSyncLines(
  changes: SyncChange[], source: SyncLine[], target: SyncLine[],
  inventoryEnabled: boolean, products: ProductoCatalogo[],
) {
  const accountChanges = changes.filter((c) => c.kind === "gasto");
  const typeChange = changes.find((c) => c.kind === "tipo");
  if (!accountChanges.length && !typeChange) return [];
  return target.flatMap((line) => {
    const current = (line.account_code ?? "").trim();
    const change = accountChanges.find((c) => c.old === current)
      ?? (!current && accountChanges.length === 1 ? accountChanges[0] : undefined);
    const account = change?.new ?? current;
    if (!isValidPurchaseAccount(account, inventoryEnabled)) return [];
    // A different valid account is not pending; in particular, 14xx never becomes an expense implicitly.
    if (!change && (!typeChange || !source.some((s) => s.account_code === current))) return [];
    if (/^14/.test(current) && !/^14/.test(account) && change?.old !== current) return [];
    const origin = source.find((s) => s.account_code === account);
    const type = typeChange ? typeChange.new : (change ? origin?.item_type : line.item_type);
    if (type !== "gasto" && type !== "producto" && type !== "servicio" && type !== "costo") return [];
    if (typeChange && line.item_type !== typeChange.old && !change) return [];
    const product = type === "producto"
      ? buscarProducto(line.description ?? "", products.filter((p) => p.active !== false && p.account_code === account), { tipos: ["producto"] }).elegido?.producto
        ?? products.find((p) => p.active !== false && p.code === origin?.code && p.account_code === account)
      : null;
    // Never invent a catalog code; the transaction accepts the source's new-product code as well.
    const code = type === "producto" ? product?.code ?? origin?.code ?? null : line.code;
    if (account === current && type === line.item_type && code === line.code) return [];
    return [{ id: line.id, position: line.position, old_account: line.account_code,
      account_code: account, account_name: change?.name ?? origin?.account_name ?? line.account_name,
      item_type: type, code }];
  });
}