// Traducción de errores técnicos de Siigo a mensajes accionables para el contador.
export function mensajeSiigoAmigable(raw: string): string {
  const cuenta = /"?code"?:\s*"?(\d{4,10})/.exec(raw)?.[1] ?? /(\d{6,10}) cannot be used/.exec(raw)?.[1];
  const encabezado = "NO SE PUDO CAUSAR LA FACTURA EN SIIGO.";

  if (raw.includes("account_not_allowed"))
    return `${encabezado}\nProblema: la cuenta ${cuenta ?? "seleccionada"} no permite movimiento porque tiene cuentas auxiliares o no es transaccional en Siigo.\nAcción: seleccione una cuenta auxiliar activa en el renglón y vuelva a causar.`;
  if (raw.includes("invalid_total_payments"))
    return `${encabezado}\nProblema: la forma de pago no coincide con el valor de la factura.\nAcción: revise el neto a pagar (total menos retenciones) y las fechas de vencimiento. No modifique el total de la factura.`;
  if (raw.includes("invalid_total"))
    return `${encabezado}\nProblema: el total enviado no cuadra con la suma de los renglones más impuestos.\nAcción: verifique subtotal, IVA e impoconsumo de los renglones.`;
  if (raw.includes("invalid_tax") || raw.includes("tax_not_found"))
    return `${encabezado}\nProblema: el impuesto enviado no existe o está inactivo en Siigo.\nAcción: sincronice los impuestos desde Integraciones → Siigo y vuelva a causar.`;
  if (raw.includes("retentions") && raw.includes("invalid_array"))
    return `${encabezado}\nProblema: la retención enviada no tiene un identificador válido de impuesto en Siigo (no se puede usar el código contable como ID).\nAcción: sincronice los impuestos desde Integraciones → Siigo para obtener el ID real de la retención.`;
  if (raw.includes("invalid_array"))
    return `${encabezado}\nProblema: uno de los datos enviados a Siigo no tiene un identificador válido.\nAcción: sincronice cuentas contables e impuestos desde Integraciones → Siigo y vuelva a intentar.`;
  if (raw.includes("supplier") || raw.includes("customer_not_found"))
    return `${encabezado}\nProblema: el proveedor de la factura no existe en Siigo.\nAcción: importe los terceros desde Integraciones o cree el proveedor en Siigo.`;
  if (raw.includes("cost_center"))
    return `${encabezado}\nProblema: el centro de costo no es válido para esta empresa en Siigo.\nAcción: sincronice los centros de costo y seleccione uno válido.`;
  return `${encabezado}\nDetalle técnico: ${raw}`;
}
