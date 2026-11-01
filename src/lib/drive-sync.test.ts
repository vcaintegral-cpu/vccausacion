import { describe, expect, it } from "vitest";

import {
  esCarpetaAnio,
  interpretarEnlace,
  tipoDeArchivo,
  esCarpetaFacturas,
  esPdf,
  idDeCarpetaDrive,
  mesDeCarpeta,
  periodosARevisar,
  pistaDePago,
} from "./drive-sync";

describe("mesDeCarpeta", () => {
  it("lee las carpetas reales de LED LIGHTS", () => {
    expect(mesDeCarpeta("10. OCTUBRE")).toBe(10);
    expect(mesDeCarpeta("6. JUNIO")).toBe(6);
    expect(mesDeCarpeta("9. SEPTIEMBRE")).toBe(9);
  });
  it("acepta solo nombre o variaciones de escritura", () => {
    expect(mesDeCarpeta("Octubre")).toBe(10);
    expect(mesDeCarpeta("SETIEMBRE")).toBe(9);
    expect(mesDeCarpeta("03 - marzo")).toBe(3);
  });
  it("no adivina cuando número y nombre se contradicen o no es un mes", () => {
    expect(mesDeCarpeta("10. JUNIO")).toBeNull();
    expect(mesDeCarpeta("FACTURAS")).toBeNull();
    expect(mesDeCarpeta("2026")).toBeNull();
    expect(mesDeCarpeta("IVAN CANO")).toBeNull();
  });
});

describe("carpetas", () => {
  it("reconoce año y FACTURAS sin importar espacios o mayúsculas", () => {
    expect(esCarpetaAnio("2026", 2026)).toBe(true);
    expect(esCarpetaAnio("2025", 2026)).toBe(false);
    expect(esCarpetaFacturas(" Facturas ")).toBe(true);
    expect(esCarpetaFacturas("CUENTAS DE COBRO")).toBe(false);
  });
});

describe("periodosARevisar", () => {
  it("revisa el mes actual y el anterior en hora de Colombia", () => {
    expect(periodosARevisar(new Date("2026-10-30T23:00:00Z"))).toEqual([
      { anio: 2026, mes: 10 },
      { anio: 2026, mes: 9 },
    ]);
  });
  it("el 1 de noviembre a las 3 a. m. UTC todavía es octubre en Colombia", () => {
    expect(periodosARevisar(new Date("2026-11-01T03:00:00Z"))[0]).toEqual({ anio: 2026, mes: 10 });
  });
  it("en enero el mes anterior es diciembre del año anterior", () => {
    expect(periodosARevisar(new Date("2027-01-15T15:00:00Z"))).toEqual([
      { anio: 2027, mes: 1 },
      { anio: 2026, mes: 12 },
    ]);
  });
});

describe("pistaDePago", () => {
  it("lee los prefijos reales de la carpeta FACTURAS", () => {
    expect(pistaDePago("Corriente16 - fv090004721702826FECT00274124.pdf")).toEqual({
      medios: ["corriente"],
      dia: 16,
    });
    expect(pistaDePago("Efectivo08 - ad086001664002726109220261008141042055.pdf")).toEqual({
      medios: ["efectivo"],
      dia: 8,
    });
    expect(pistaDePago("Efectivo+Corriente01 - fv090004721702826FECT00271600.pdf")).toEqual({
      medios: ["efectivo", "corriente"],
      dia: 1,
    });
  });
  it("sin prefijo o con prefijo desconocido no hay pista", () => {
    expect(pistaDePago("ad086001664002726566920261028175206607.pdf")).toBeNull();
    expect(pistaDePago("Proveedor - factura 123.pdf")).toBeNull();
    expect(pistaDePago("Corriente45 - x.pdf")).toBeNull();
  });
});

describe("utilidades", () => {
  it("solo PDF", () => {
    expect(esPdf("a.PDF", null)).toBe(true);
    expect(esPdf("a.xml", "text/xml")).toBe(false);
  });
  it("extrae el ID de carpeta del enlace compartido", () => {
    expect(
      idDeCarpetaDrive(
        "https://drive.google.com/drive/folders/1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK?usp=sharing",
      ),
    ).toBe("1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK");
    expect(idDeCarpetaDrive("1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK")).toBe(
      "1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK",
    );
    expect(idDeCarpetaDrive("no es un enlace")).toBeNull();
  });
});

describe("interpretarEnlace", () => {
  it("lee el enlace de OneDrive de BALLET (navegación onedrive.aspx)", () => {
    expect(
      interpretarEnlace(
        "https://integralvc-my.sharepoint.com/personal/mbustamante_integralyasesores_com/_layouts/15/onedrive.aspx?id=%2Fpersonal%2Fmbustamante%5Fintegralyasesores%5Fcom%2FDocuments%2FMis%20Empresas%2FBALLET%2F2026%2FCONTABILIDAD&viewid=ff769d53%2Ded88%2D4b13%2Da6a9%2Dd0ff28c578f7&at=9&view=0",
      ),
    ).toEqual({
      proveedor: "microsoft",
      tipo: "ruta",
      host: "integralvc-my.sharepoint.com",
      sitio: "/personal/mbustamante_integralyasesores_com",
      biblioteca: "Documents",
      ruta: "Mis Empresas/BALLET/2026/CONTABILIDAD",
    });
  });
  it("lee carpetas de SharePoint de un sitio y vínculos compartidos", () => {
    expect(
      interpretarEnlace(
        "https://integralvc.sharepoint.com/sites/Contabilidad/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FContabilidad%2FShared%20Documents%2FBALLET",
      ),
    ).toMatchObject({
      proveedor: "microsoft",
      tipo: "ruta",
      sitio: "/sites/Contabilidad",
      biblioteca: "Shared Documents",
      ruta: "BALLET",
    });
    expect(
      interpretarEnlace("https://integralvc-my.sharepoint.com/:f:/g/personal/x/EabcDEF"),
    ).toEqual({
      proveedor: "microsoft",
      tipo: "compartido",
      url: "https://integralvc-my.sharepoint.com/:f:/g/personal/x/EabcDEF",
    });
  });
  it("lee Google Drive y rechaza otros sitios", () => {
    expect(
      interpretarEnlace(
        "https://drive.google.com/drive/folders/1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK?usp=sharing",
      ),
    ).toEqual({
      proveedor: "google",
      folderId: "1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK",
    });
    expect(interpretarEnlace("https://www.dropbox.com/home/x")).toBeNull();
    expect(interpretarEnlace("")).toBeNull();
  });
});

describe("tipoDeArchivo", () => {
  it("compras: PDF a lectura IA y Excel como RECIBIDOS", () => {
    expect(tipoDeArchivo("compras", "fv0900047217.pdf", "application/pdf")).toBe("factura_pdf");
    expect(tipoDeArchivo("compras", "RECIBIDOS - BALLET.xlsx", null)).toBe("recibidos_excel");
    expect(tipoDeArchivo("compras", "foto.jpg", "image/jpeg")).toBeNull();
  });
  it("egresos: soportes de pago y extractos", () => {
    expect(tipoDeArchivo("egresos", "Comprobante transferencia 123.pdf", "application/pdf")).toBe(
      "soporte_pago",
    );
    expect(tipoDeArchivo("egresos", "Extracto Bancolombia octubre.pdf", "application/pdf")).toBe(
      "extracto",
    );
    expect(tipoDeArchivo("egresos", "movimientos.xlsx", null)).toBe("extracto");
    expect(tipoDeArchivo("egresos", "nota.txt", "text/plain")).toBeNull();
  });
});
