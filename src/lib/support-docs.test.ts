import { describe, expect, it } from "vitest";
import { fillVendorFromCompany, missingIdentity, moneyCents, nitDV, parseSupportRows, siigoIdType, splitPersonName, supplierReceiptNumber, dsSendDate, dianLabel, diasParaDian, resolutionExpiry } from "./support-docs";

const r = (o: Record<string, string>, n: number) => ({
  rowNumber: n,
  row: Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(), v])),
});
const base = { FECHA: "05/10/2026", "TIPO DOC VENDEDOR": "CC", "NIT/CC VENDEDOR": "71654321", "NOMBRE VENDEDOR": "Juan Carlos Pérez Gómez", "NUMERO CUENTA COBRO": "015", DESCRIPCION: "Clase de danza", CANTIDAD: "1", "VALOR UNITARIO": "500.000", "VALOR TOTAL": "500.000" };

describe("documentos soporte", () => {
  it("rows with the same NIT/CC + cuenta de cobro form one document", () => {
    const { docs, errors } = parseSupportRows([r(base, 4), r({ ...base, DESCRIPCION: "Transporte", "VALOR UNITARIO": "50.000", "VALOR TOTAL": "50.000" }, 5)]);
    expect(errors).toEqual([]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.totalCents).toBe(55000000);
    expect(docs[0]!.number).toBe("015");
  });
  it("reports format errors per row", () => {
    const { errors } = parseSupportRows([r({ ...base, "VALOR TOTAL": "" }, 7)]);
    expect(errors[0]!.row).toBe(7);
  });
  it("Colombian money format in cents", () => {
    expect(moneyCents("1.234.567,89")).toBe(123456789);
    expect(moneyCents("1,234,567.89")).toBe(123456789);
    expect(moneyCents("500.000")).toBe(50000000);
  });
  it("Siigo id types and NIT check digit", () => {
    expect(siigoIdType("Cédula")).toBe("13");
    expect(siigoIdType("NIT")).toBe("31");
    expect(siigoIdType("CE")).toBe("22");
    expect(siigoIdType("Pasaporte")).toBe("41");
    expect(nitDV("890900608")).toBe("9");
  });
  it("person name split", () => {
    expect(splitPersonName("Juan Carlos Pérez Gómez")).toEqual({ firstNames: "Juan Carlos", lastNames: "Pérez Gómez" });
  });
  it("only contact data is filled from the company; identity never", () => {
    const { vendor, filled } = fillVendorFromCompany({ address: "", city: "Bello", phone: null, email: null }, { address: "CR 50 59 71", city: "Medellín", phone: "6042546637", email: "Contabilidad@bfda.org" });
    expect(vendor.address).toBe("CR 50 59 71");
    expect(vendor.city).toBe("Bello");
    expect(filled).toEqual(["address", "phone", "email"]);
    expect(missingIdentity({ idNumber: "", idType: "13", name: "x" })).toEqual(["identificación"]);
  });
  it("supplier receipt number has 11 digits", () => {
    expect(supplierReceiptNumber("015")).toBe("00000000015");
  });
});

describe("ventana de fechas Siigo", () => {
  it("dentro de la ventana envía la fecha de la operación sin cambios", () => {
    expect(dsSendDate("2026-09-25", "2026-10-18", 10, "fin_mes")).toEqual({ sendDate: "2026-09-25", changed: false, lastDay: "2026-09-30" });
  });
  it("fuera de la ventana propone la fecha mínima (30/09 - 10 días = 20/09)", () => {
    expect(dsSendDate("2026-09-01", "2026-10-18", 10, "fin_mes")).toEqual({ sendDate: "2026-09-20", changed: true, lastDay: "2026-09-30" });
  });
  it("la fecha enviada nunca supera el último día del mes ni hoy", () => {
    expect(dsSendDate("2026-10-18", "2026-10-17", 10, "fin_mes").sendDate).toBe("2026-10-17");
  });
  it("con referencia hoy usa hoy - N días", () => {
    expect(dsSendDate("2026-09-01", "2026-10-18", 10, "hoy").sendDate).toBe("2026-09-30"); // hoy−10 = 08/10, pero nunca supera el último día del mes del documento
  });
});

describe("estado DIAN", () => {
  it("mapea los estados de Siigo a las tres etiquetas", () => {
    expect(dianLabel(null)).toBe("Guardado – pendiente envío DIAN");
    expect(dianLabel("Sent")).toBe("Enviado a la DIAN");
    expect(dianLabel("Accepted")).toBe("Validado DIAN");
    expect(dianLabel("Rejected")).toBe("Rechazado DIAN");
  });
  it("cuenta los días desde la fecha de elaboración", () => {
    expect(diasParaDian("2026-10-16", "2026-10-18")).toBe(2);
    expect(diasParaDian(null, "2026-10-18")).toBeNull();
  });
});

describe("resolución de numeración", () => {
  it("vence a los 12 meses de la aprobación", () => {
    expect(resolutionExpiry("2025-10-23", 12)).toBe("2026-10-23");
  });
});
