import { supabase } from "@/integrations/supabase/client";

const PUC = [
  ["110505", "Caja general", "debito"],
  ["111005", "Bancos", "debito"],
  ["143505", "Inventario de mercancías", "debito"],
  ["152405", "Equipo de cómputo y comunicación", "debito"],
  ["220505", "Proveedores nacionales", "credito"],
  ["233595", "Costos y gastos por pagar", "credito"],
  ["236540", "Retención en la fuente - compras", "credito"],
  ["236701", "Retención de IVA", "credito"],
  ["236805", "Retención de ICA", "credito"],
  ["621008", "IVA del costo", "debito"],
  ["513595", "Servicios varios", "debito"],
  ["5135", "Seguros", "debito"],
  ["519525", "Papelería y útiles de oficina", "debito"],
  ["519595", "Gastos diversos", "debito"],
  ["521595", "Impuestos asumidos", "debito"],
];

const REGLAS = [
  ["computador", "152405", "Equipo de cómputo y comunicación", 10],
  ["portatil", "152405", "Equipo de cómputo y comunicación", 10],
  ["papeleria", "519525", "Papelería y útiles de oficina", 20],
  ["resma", "519525", "Papelería y útiles de oficina", 20],
  ["restaurante", "519595", "Alimentación", 30],
  ["almuerzo", "519595", "Alimentación", 30],
  ["seguro", "5135", "Seguros", 40],
  ["poliza", "5135", "Seguros", 40],
];

const IMPUESTOS = [
  ["iva", "IVA general 19%", 19, 0, "621008"],
  ["retefuente", "Retefuente compras 2.5%", 2.5, 1_412_000, "236540"],
  ["reteiva", "ReteIVA 15%", 15, 1_412_000, "236701"],
  ["reteica", "ReteICA 9.66 x mil", 0.966, 0, "236805"],
];

const CENTROS = [
  ["001", "Administración"],
  ["002", "Ventas"],
  ["003", "Operaciones"],
];

/** Crea la empresa con su PUC, reglas, impuestos y centros de costo base. */
export async function createCompanyWithDefaults(input: { name: string; nit: string }, userId: string) {
  const { data: company, error } = await supabase
    .from("companies")
    .insert({ name: input.name, nit: input.nit, created_by: userId })
    .select()
    .single();
  if (error) throw error;

  const companyId = company.id;
  // El miembro propietario lo crea automáticamente un trigger en la base de datos.

  await Promise.all([
    supabase
      .from("puc_accounts")
      .insert(PUC.map(([code, name, nature]) => ({ company_id: companyId, code: String(code), name: String(name), nature: String(nature) }))),
    supabase.from("accounting_rules").insert(
      REGLAS.map(([match_value, account_code, account_name, priority]) => ({
        company_id: companyId,
        match_type: "keyword",
        match_value: String(match_value),
        account_code: String(account_code),
        account_name: String(account_name),
        priority: Number(priority),
      })),
    ),
    supabase.from("tax_rates").insert(
      IMPUESTOS.map(([kind, name, rate, min_base, account_code]) => ({
        company_id: companyId,
        kind: String(kind),
        name: String(name),
        rate: Number(rate),
        min_base: Number(min_base),
        account_code: String(account_code),
      })),
    ),
    supabase
      .from("cost_centers")
      .insert(CENTROS.map(([code, name]) => ({ company_id: companyId, code: String(code), name: String(name) }))),
  ]);

  return company;
}