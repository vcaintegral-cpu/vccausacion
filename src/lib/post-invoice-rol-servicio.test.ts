import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("post_invoice con el cliente de servicio del piloto", () => {
  const sql = readFileSync(
    "supabase/migrations/20261122120000_post_invoice_rol_servicio.sql",
    "utf8",
  );
  it("acepta el rol de servicio además de la membresía de la usuaria", () => {
    expect(sql).toContain("auth.role(), '') = 'service_role'");
    expect(sql).toContain("public.is_company_member(v_inv.company_id)");
  });
  it("permite ejecutar la función al rol de servicio", () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_invoice\(uuid\) TO authenticated, service_role/);
  });
});
