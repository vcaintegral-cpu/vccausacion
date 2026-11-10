import { describe, expect, it } from "vitest";

import { errorCode } from "./bulk-diagnostics";
import {
  esAvisoNotaCredito,
  estadoDeFactura,
  facturaReferidaEnExcel,
  facturaReferidaEnTexto,
  facturaReferidaEnValor,
  mensajeNotaCredito,
  notaCreditoGuardada,
  pareceNotaCredito,
} from "./nota-credito";

describe("factura afectada", () => {
  it("lee la columna NOTA real de LAUMAYER (Excel RECIBIDOS de octubre)", () => {
    expect(
      facturaReferidaEnExcel({
        "TIPO DE OPERACION": "Nota crédito sin referencia",
        NOTA: "SE APLICA A FACTURA CFA 109836 - CAMBIO DE REFERENCIA\n001|LED LIGHTS SAS|1111794.39",
      }),
    ).toEqual({ prefijo: "CFA", numero: "109836" });
  });
  it("NC241 sin nota ni columna de referencia: sin factura", () => {
    expect(facturaReferidaEnExcel({ "TIPO DE OPERACION": "Nota crédito con referencia a factura", NOTA: "" })).toBeNull();
  });
  it("prefiere una columna de referencia si el Procesador la trae", () => {
    expect(facturaReferidaEnExcel({ "FACTURA REFERENCIA": "FE-0001234", NOTA: "" })).toEqual({
      prefijo: "FE",
      numero: "1234",
    });
  });
  it("otras redacciones habituales", () => {
    expect(facturaReferidaEnTexto("Afecta la factura No. CFA109836")).toEqual({ prefijo: "CFA", numero: "109836" });
    expect(facturaReferidaEnTexto("Factura de referencia: FV-77")).toEqual({ prefijo: "FV", numero: "77" });
    expect(facturaReferidaEnTexto("Devolución de mercancía")).toBeNull();
    expect(facturaReferidaEnValor("CFA 109836")).toEqual({ prefijo: "CFA", numero: "109836" });
    expect(facturaReferidaEnValor("no aplica")).toBeNull();
  });
});

describe("pareceNotaCredito", () => {
  it("reconoce la nota por la IA, el XML, el encabezado, el nombre DIAN o el total negativo", () => {
    expect(pareceNotaCredito({ documentType: "nota_credito" })).toBe(true);
    expect(pareceNotaCredito({ tipoDocumento: "Nota de crédito electrónica" })).toBe(true);
    expect(pareceNotaCredito({ texto: '<CreditNote xmlns="urn:oasis">' })).toBe(true);
    expect(pareceNotaCredito({ texto: "LAUMAYER S.A.S.\nNOTA CRÉDITO ELECTRÓNICA No. LYNA6692" })).toBe(true);
    expect(pareceNotaCredito({ archivo: "nc08909213350002600006692.pdf" })).toBe(true);
    expect(pareceNotaCredito({ archivo: "Corriente07 - nc08909213350002600006692.pdf" })).toBe(true);
    expect(pareceNotaCredito({ total: -235000 })).toBe(true);
  });
  it("una factura normal no es nota crédito, aunque su letra pequeña las mencione", () => {
    expect(
      pareceNotaCredito({
        documentType: "factura",
        texto: "FACTURA ELECTRÓNICA DE VENTA FECT272708" + " ".repeat(3000) + "Las notas crédito electrónicas se emiten...",
        archivo: "Corriente16 - fv090004721702826FECT00274124.pdf",
        total: 150000,
      }),
    ).toBe(false);
  });
  it("borrador ya guardado desde el Excel o el PDF", () => {
    expect(notaCreditoGuardada({ raw_extraction: { tipo_documento: "Nota de crédito electrónica" }, total: 100 })).toBe(true);
    expect(notaCreditoGuardada({ raw_extraction: { ia: { document_type: "nota_credito" } }, total: 100 })).toBe(true);
    expect(notaCreditoGuardada({ raw_extraction: { ia: { document_type: "factura" }, archivo: "fv0900.pdf" }, total: 100 })).toBe(false);
    expect(notaCreditoGuardada({ raw_extraction: null, total: 100 })).toBe(false);
  });
});

describe("estado de la factura afectada y aviso", () => {
  const filas = [
    { prefix: "CFA", number: "109836", provider_nit: "890921335", siigo_id: "abc", siigo_number: "FC-1-757", siigo_status: "sincronizada", status: "sincronizada" },
    { prefix: "CFA", number: "109976", provider_nit: "890921335", siigo_id: null, siigo_number: null, siigo_status: null, status: "borrador" },
    { prefix: "X", number: "109836", provider_nit: "800000000", siigo_id: "z", siigo_number: "FC-1-1", siigo_status: "sincronizada", status: "sincronizada" },
  ];
  it("distingue causada en Siigo, pendiente y no registrada (mismo proveedor y prefijo)", () => {
    expect(estadoDeFactura({ prefijo: "CFA", numero: "109836" }, "890921335", filas)).toEqual({
      tipo: "en_siigo",
      factura: { prefijo: "CFA", numero: "109836" },
      siigo: "FC-1-757",
    });
    expect(estadoDeFactura({ prefijo: "CFA", numero: "109976" }, "890921335", filas).tipo).toBe("pendiente_siigo");
    expect(estadoDeFactura({ prefijo: "CFA", numero: "1" }, "890921335", filas).tipo).toBe("no_registrada");
    expect(estadoDeFactura({ prefijo: "CFA", numero: "109836" }, "811111111", filas).tipo).toBe("no_registrada");
    expect(estadoDeFactura(null, "890921335", filas).tipo).toBe("sin_referencia");
  });
  it("aviso completo y reconocible en pantalla", () => {
    const m = mensajeNotaCredito({
      numero: "LYNA6692",
      proveedor: "LAUMAYER COLOMBIANA COMERCIALIZADORA S.A.S.",
      nit: "890921335",
      total: -1111794.39,
      estado: { tipo: "en_siigo", factura: { prefijo: "CFA", numero: "109836" }, siigo: "FC-1-757" },
    });
    expect(m).toMatch(/^NOTA CRÉDITO — REGISTRO MANUAL EN SIIGO\./);
    expect(m).toContain("LYNA6692");
    expect(m).toContain("no se causa ni se envía a Siigo");
    expect(m).toContain("sobre la factura CFA 109836");
    expect(m).toContain("ya está causada en Siigo (FC-1-757)");
    expect(m).toMatch(/1\.111\.794,39/);
    expect(esAvisoNotaCredito(m)).toBe(true);
    expect(errorCode("validating_company", m)).toBe("CREDIT_NOTE");

    const sinRef = mensajeNotaCredito({ numero: "NC241", proveedor: "LEIDY TATIANA HOYOS DUQUE", nit: "1036643870", total: -235000, estado: { tipo: "sin_referencia" } });
    expect(sinRef).toContain("no indica la factura afectada");
    const pendiente = mensajeNotaCredito({ numero: "LYNA6691", proveedor: "LAUMAYER", nit: "890921335", total: -462710.08, estado: { tipo: "pendiente_siigo", factura: { prefijo: "CFA", numero: "109976" } } });
    expect(pendiente).toContain("aún no se ha causado en Siigo: cáusela primero");
  });
});
