// Lector de facturas electrónicas DIAN (XML UBL 2.1) — sin IA.
// Convierte el XML de una factura de venta (la compra de la empresa) en la MISMA estructura
// ExtractedInvoice que produce la lectura del PDF o del Excel RECIBIDOS, para que pase por la misma
// función de causación. Soporta el XML «Invoice» directo y el contenedor «AttachedDocument»
// (la factura va dentro de un CDATA). Las notas crédito/débito y otros documentos se informan, no se causan.
import type { ExtractedInvoice, ExtractedLine } from "@/lib/extract.functions";

type Nodo = { name: string; attrs: Record<string, string>; children: Nodo[]; text: string };

const ENTIDADES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodificar(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}

const sinPrefijo = (n: string) => n.replace(/^.*:/, "");

/** Árbol mínimo de un XML (nombres sin prefijo de espacio de nombres). Suficiente para UBL de la DIAN. */
export function parsearXml(xml: string): Nodo {
  const raiz: Nodo = { name: "#raiz", attrs: {}, children: [], text: "" };
  const pila: Nodo[] = [raiz];
  const re =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const actual = pila[pila.length - 1]!;
    if (m[1] !== undefined) {
      actual.text += m[1];
    } else if (m[3] !== undefined) {
      if (m[2] === "/") {
        if (pila.length > 1) pila.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
          attrs[sinPrefijo(a[1]!)] = decodificar(a[2] ?? a[3] ?? "");
        const nodo: Nodo = { name: sinPrefijo(m[3]), attrs, children: [], text: "" };
        actual.children.push(nodo);
        if (m[5] !== "/") pila.push(nodo);
      }
    } else if (m[6] !== undefined) {
      actual.text += decodificar(m[6]);
    }
  }
  return raiz;
}

const hijos = (n: Nodo | undefined, nombre: string) =>
  (n?.children ?? []).filter((c) => c.name === nombre);
const hijo = (n: Nodo | undefined, ...ruta: string[]): Nodo | undefined => {
  let cur = n;
  for (const r of ruta) {
    cur = hijos(cur, r)[0];
    if (!cur) return undefined;
  }
  return cur;
};
const texto = (n: Nodo | undefined, ...ruta: string[]): string =>
  (hijo(n, ...ruta)?.text ?? "").trim();
function descendientes(n: Nodo, nombre: string, out: Nodo[] = []): Nodo[] {
  for (const c of n.children) {
    if (c.name === nombre) out.push(c);
    descendientes(c, nombre, out);
  }
  return out;
}
const num = (s: string | undefined): number => {
  const v = Number(String(s ?? "").trim());
  return Number.isFinite(v) ? v : 0;
};
const soloDigitos = (s: string) => s.replace(/\D/g, "");

const MEDIOS_PAGO: Record<string, string> = {
  "10": "Efectivo",
  "20": "Cheque",
  "30": "Transferencia crédito",
  "31": "Transferencia débito",
  "42": "Consignación bancaria",
  "47": "Transferencia débito bancaria",
  "48": "Tarjeta crédito",
  "49": "Tarjeta débito",
  ZZ: "Acuerdo mutuo",
};

type Parte = {
  nit: string | null;
  nombre: string | null;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  correo: string | null;
};

function leerParte(rol: Nodo | undefined): Parte {
  const p = hijo(rol, "Party");
  const nombre =
    texto(p, "PartyTaxScheme", "RegistrationName") ||
    texto(p, "PartyLegalEntity", "RegistrationName") ||
    texto(p, "PartyName", "Name");
  const nit =
    soloDigitos(texto(p, "PartyTaxScheme", "CompanyID")) ||
    soloDigitos(texto(p, "PartyLegalEntity", "CompanyID"));
  const dir =
    hijo(p, "PhysicalLocation", "Address") ?? hijo(p, "PartyTaxScheme", "RegistrationAddress");
  return {
    nit: nit || null,
    nombre: nombre || null,
    direccion: texto(dir, "AddressLine", "Line") || null,
    ciudad: texto(dir, "CityName") || null,
    telefono: texto(p, "Contact", "Telephone") || null,
    correo: texto(p, "Contact", "ElectronicMail") || null,
  };
}

type Impuesto = { esquema: string; base: number; valor: number; porcentaje: number };

function leerImpuestos(total: Nodo | undefined): Impuesto[] {
  const out: Impuesto[] = [];
  for (const sub of hijos(total, "TaxSubtotal"))
    out.push({
      esquema: texto(sub, "TaxCategory", "TaxScheme", "ID"),
      base: num(texto(sub, "TaxableAmount")),
      valor: num(texto(sub, "TaxAmount")),
      porcentaje: num(texto(sub, "TaxCategory", "Percent")),
    });
  return out;
}

export type LecturaFacturaXml =
  | { ok: true; extracted: ExtractedInvoice; cufe: string | null }
  | {
      ok: false;
      /** «nota_credito», «nota_debito» u «otro»: no se causa por este flujo. */
      tipo: "nota_credito" | "nota_debito" | "otro" | "invalido";
      motivo: string;
      cufe: string | null;
      numero: string | null;
      proveedorNit: string | null;
      proveedorNombre: string | null;
      total: number;
    };

function buscarFactura(raiz: Nodo): Nodo | null {
  const directo = raiz.children.find((c) =>
    ["Invoice", "CreditNote", "DebitNote"].includes(c.name),
  );
  if (directo) return directo;
  // AttachedDocument: la factura viaja como texto (CDATA) dentro de la descripción del adjunto.
  const contenedor = raiz.children.find((c) => c.name === "AttachedDocument");
  if (!contenedor) return null;
  for (const d of descendientes(contenedor, "Description")) {
    if (/<(\w+:)?(Invoice|CreditNote|DebitNote)[\s>]/.test(d.text)) {
      const interno = parsearXml(d.text);
      const f = interno.children.find((c) =>
        ["Invoice", "CreditNote", "DebitNote"].includes(c.name),
      );
      if (f) return f;
    }
  }
  return null;
}

export function leerFacturaXml(xml: string): LecturaFacturaXml {
  const vacio = {
    cufe: null,
    numero: null,
    proveedorNit: null,
    proveedorNombre: null,
    total: 0,
  };
  let doc: Nodo | null;
  try {
    doc = buscarFactura(parsearXml(xml.replace(/^﻿/, "")));
  } catch (e) {
    return {
      ok: false,
      tipo: "invalido",
      motivo: `XML ilegible: ${e instanceof Error ? e.message : String(e)}`,
      ...vacio,
    };
  }
  if (!doc)
    return {
      ok: false,
      tipo: "otro",
      motivo: "El XML no es una factura electrónica (no trae Invoice).",
      ...vacio,
    };

  const idCompleto = texto(doc, "ID");
  const cufe = texto(doc, "UUID").toLowerCase() || null;
  const proveedor = leerParte(hijo(doc, "AccountingSupplierParty"));
  const comprador = leerParte(hijo(doc, "AccountingCustomerParty"));
  const monetario = hijo(doc, "LegalMonetaryTotal");
  const totalDoc = num(texto(monetario, "PayableAmount"));
  const base = {
    cufe,
    numero: idCompleto || null,
    proveedorNit: proveedor.nit,
    proveedorNombre: proveedor.nombre,
    total: totalDoc,
  };
  const codigoTipo = texto(doc, "InvoiceTypeCode") || texto(doc, "CreditNoteTypeCode");
  if (doc.name === "CreditNote")
    return {
      ok: false,
      tipo: "nota_credito",
      motivo: "Nota crédito: se registra manualmente sobre la factura causada.",
      ...base,
    };
  if (doc.name === "DebitNote")
    return {
      ok: false,
      tipo: "nota_debito",
      motivo: "Nota débito: se revisa manualmente.",
      ...base,
    };
  // 01 venta, 02 exportación, 03 contingencia, 04 contingencia DIAN. Otros (p. ej. 05 documento soporte, 91/92 notas) no.
  if (codigoTipo && !["01", "02", "03", "04"].includes(codigoTipo))
    return {
      ok: false,
      tipo: codigoTipo === "91" ? "nota_credito" : codigoTipo === "92" ? "nota_debito" : "otro",
      motivo: `Tipo de documento ${codigoTipo}: no es una factura de venta.`,
      ...base,
    };
  if (!idCompleto || !proveedor.nit || !texto(doc, "IssueDate"))
    return {
      ok: false,
      tipo: "invalido",
      motivo: "Al XML le falta el número, la fecha o el NIT del emisor.",
      ...base,
    };

  const m = /^(.*?)(\d+)$/.exec(idCompleto);
  const prefijo = m ? m[1]!.replace(/[-_\s]+$/g, "") : "";
  const numero = m ? m[2]! : idCompleto;

  // Solo los TaxTotal del encabezado (hijos directos de la factura), no los de cada línea.
  const totalesImp = hijos(doc, "TaxTotal").flatMap((t) => leerImpuestos(t));
  const suma = (lista: Impuesto[], esq: string) =>
    lista.filter((i) => i.esquema === esq).reduce((s, i) => s + i.valor, 0);
  const retenciones = hijos(doc, "WithholdingTaxTotal").flatMap((t) => leerImpuestos(t));

  const lineas: ExtractedLine[] = hijos(doc, "InvoiceLine").map((l) => {
    const imp = hijos(l, "TaxTotal").flatMap((t) => leerImpuestos(t));
    const iva = imp.find((i) => i.esquema === "01");
    const subtotal = num(texto(l, "LineExtensionAmount"));
    const cantidad = num(texto(l, "InvoicedQuantity")) || 1;
    const precio = num(texto(l, "Price", "PriceAmount"));
    return {
      code:
        texto(l, "Item", "SellersItemIdentification", "ID") ||
        texto(l, "Item", "StandardItemIdentification", "ID") ||
        null,
      description: texto(l, "Item", "Description") || "Sin descripción",
      quantity: cantidad,
      unit_value: precio || subtotal / cantidad,
      subtotal,
      iva_base: iva?.base ?? subtotal,
      iva_rate: iva?.porcentaje ?? 0,
      discount: 0,
      iva: iva?.valor ?? 0,
      retention: 0,
      impoconsumo: suma(imp, "04"),
      total: subtotal,
    };
  });

  const notas = hijos(doc, "Note")
    .map((n) => n.text.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
  const forma = texto(doc, "PaymentMeans", "ID");
  const medio = texto(doc, "PaymentMeans", "PaymentMeansCode");

  const extracted: ExtractedInvoice = {
    document_type: "factura",
    prefix: prefijo || null,
    number: numero,
    issue_date: texto(doc, "IssueDate") || null,
    due_date: texto(doc, "PaymentMeans", "PaymentDueDate") || texto(doc, "DueDate") || null,
    provider_nit: proveedor.nit,
    provider_name: proveedor.nombre,
    provider_address: proveedor.direccion,
    provider_city: proveedor.ciudad,
    provider_phone: proveedor.telefono,
    provider_email: proveedor.correo,
    buyer_nit: comprador.nit,
    buyer_name: comprador.nombre,
    cufe,
    payment_form: forma === "1" ? "Contado" : forma === "2" ? "Crédito" : forma || null,
    payment_method: MEDIOS_PAGO[medio] ?? (medio || null),
    currency: texto(doc, "DocumentCurrencyCode") || "COP",
    cost_center: null,
    notes: notas || null,
    subtotal: num(texto(monetario, "LineExtensionAmount")),
    discount: num(texto(monetario, "AllowanceTotalAmount")),
    surcharge: num(texto(monetario, "ChargeTotalAmount")),
    iva: suma(totalesImp, "01"),
    impoconsumo: suma(totalesImp, "04"),
    retefuente: suma(retenciones, "06"),
    reteiva: suma(retenciones, "05"),
    reteica: suma(retenciones, "07"),
    total: totalDoc,
    lines: lineas,
  };
  return { ok: true, extracted, cufe };
}

/** ¿El nombre o tipo MIME corresponde a un XML? */
export function esXml(nombre: string, mimeType: string | null | undefined): boolean {
  return /\.xml$/i.test(nombre) || mimeType === "text/xml" || mimeType === "application/xml";
}
