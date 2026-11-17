import { describe, expect, it } from "vitest";
import { esXml, leerFacturaXml } from "./factura-xml";

// Factura ficticia con la estructura UBL 2.1 de la DIAN (datos inventados).
const factura = (extra = "", tipo = "01") => `<?xml version="1.0" encoding="utf-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><x>firma</x></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
<cbc:ID>FE5001</cbc:ID>
<cbc:UUID schemeName="CUFE-SHA384">ABC123def</cbc:UUID>
<cbc:IssueDate>2026-11-05</cbc:IssueDate>
<cbc:InvoiceTypeCode>${tipo}</cbc:InvoiceTypeCode>
<cbc:Note>Pedido &amp; entrega</cbc:Note><cbc:Note />
<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party>
 <cac:PartyName><cbc:Name>PROVEEDOR PRUEBA</cbc:Name></cac:PartyName>
 <cac:PhysicalLocation><cac:Address><cbc:CityName>CALI </cbc:CityName><cac:AddressLine><cbc:Line>CALLE 1 2 3</cbc:Line></cac:AddressLine></cac:Address></cac:PhysicalLocation>
 <cac:PartyTaxScheme><cbc:RegistrationName>PROVEEDOR PRUEBA S.A.S.</cbc:RegistrationName><cbc:CompanyID schemeID="8">900111222</cbc:CompanyID></cac:PartyTaxScheme>
 <cac:Contact><cbc:Telephone>6021234567</cbc:Telephone><cbc:ElectronicMail>pagos@prueba.test</cbc:ElectronicMail></cac:Contact>
</cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party>
 <cac:PartyTaxScheme><cbc:RegistrationName>EMPRESA COMPRADORA SAS</cbc:RegistrationName><cbc:CompanyID schemeID="4">900999888</cbc:CompanyID></cac:PartyTaxScheme>
</cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:ID>2</cbc:ID><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-12-05</cbc:PaymentDueDate></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount>19000.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount>100000.00</cbc:TaxableAmount><cbc:TaxAmount>19000.00</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>19.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
${extra}
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount>100000.00</cbc:LineExtensionAmount><cbc:AllowanceTotalAmount>0.00</cbc:AllowanceTotalAmount><cbc:ChargeTotalAmount>0.00</cbc:ChargeTotalAmount><cbc:PayableAmount>119000.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="94">2.000</cbc:InvoicedQuantity><cbc:LineExtensionAmount>100000.00</cbc:LineExtensionAmount>
 <cac:TaxTotal><cbc:TaxAmount>19000.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount>100000.00</cbc:TaxableAmount><cbc:TaxAmount>19000.00</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>19.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
 <cac:Item><cbc:Description>PANEL LED</cbc:Description><cac:SellersItemIdentification><cbc:ID>PL-01</cbc:ID></cac:SellersItemIdentification></cac:Item>
 <cac:Price><cbc:PriceAmount>50000.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;

describe("leerFacturaXml", () => {
  it("convierte una factura UBL en la estructura de causación", () => {
    const r = leerFacturaXml(factura());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.extracted;
    expect(e.prefix).toBe("FE");
    expect(e.number).toBe("5001");
    expect(e.cufe).toBe("abc123def");
    expect(e.issue_date).toBe("2026-11-05");
    expect(e.due_date).toBe("2026-12-05");
    expect(e.provider_nit).toBe("900111222");
    expect(e.provider_name).toBe("PROVEEDOR PRUEBA S.A.S.");
    expect(e.provider_city).toBe("CALI");
    expect(e.provider_email).toBe("pagos@prueba.test");
    expect(e.buyer_nit).toBe("900999888");
    expect(e.payment_form).toBe("Crédito");
    expect(e.payment_method).toBe("Consignación bancaria");
    expect(e.subtotal).toBe(100000);
    expect(e.iva).toBe(19000);
    expect(e.total).toBe(119000);
    expect(e.notes).toBe("Pedido & entrega");
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]).toMatchObject({
      code: "PL-01",
      description: "PANEL LED",
      quantity: 2,
      unit_value: 50000,
      subtotal: 100000,
      iva_base: 100000,
      iva_rate: 19,
      iva: 19000,
    });
  });

  it("lee las retenciones del encabezado", () => {
    const r = leerFacturaXml(
      factura(
        `<cac:WithholdingTaxTotal><cac:TaxSubtotal><cbc:TaxableAmount>100000</cbc:TaxableAmount><cbc:TaxAmount>2500</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>06</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:WithholdingTaxTotal>`,
      ),
    );
    expect(r.ok && r.extracted.retefuente).toBe(2500);
  });

  it("lee la factura dentro de un AttachedDocument", () => {
    const interno = factura().replace(/^<\?xml[^>]*\?>\s*/, "");
    const envoltura = `<?xml version="1.0"?><AttachedDocument xmlns:cac="urn:x" xmlns:cbc="urn:y"><cac:Attachment><cac:ExternalReference><cbc:Description><![CDATA[${interno}]]></cbc:Description></cac:ExternalReference></cac:Attachment></AttachedDocument>`;
    const r = leerFacturaXml(envoltura);
    expect(r.ok && r.extracted.number).toBe("5001");
  });

  it("no causa notas crédito ni documentos que no son factura de venta", () => {
    expect(leerFacturaXml(factura("", "91"))).toMatchObject({ ok: false, tipo: "nota_credito" });
    expect(leerFacturaXml(factura("", "05"))).toMatchObject({ ok: false, tipo: "otro" });
    expect(leerFacturaXml(`<CreditNote><ID>NC1</ID></CreditNote>`)).toMatchObject({
      ok: false,
      tipo: "nota_credito",
    });
    expect(leerFacturaXml("<Otra><a/></Otra>")).toMatchObject({ ok: false, tipo: "otro" });
  });

  it("reconoce archivos XML", () => {
    expect(esXml("FE5001_900111222_PROVEEDOR.xml", null)).toBe(true);
    expect(esXml("x.pdf", "application/pdf")).toBe(false);
    expect(esXml("sin-extension", "text/xml")).toBe(true);
  });
});
