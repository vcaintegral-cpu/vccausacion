# IVA y retenciones con precedente histórico

Alcance: **todas las empresas** (núcleo global).

## Qué aprende la herramienta
Para cada proveedor, a partir de lo que **ya se sincronizó con Siigo** (facturas y
documentos soporte con número en Siigo) y del **auxiliar de Siigo** importado en
Aprendizaje contable:

- **IVA:** el impuesto exacto que se le ha usado (por ejemplo, "IVA 19 % bienes" o
  "IVA 19 % servicios") y cuántas veces.
- **Retenciones:** a qué proveedores se les ha practicado Retefuente, ReteIVA y
  ReteICA, con qué impuesto o cuenta y tarifa. También en cuántos documentos
  **no** se les retuvo.

El precedente se actualiza solo: cada factura que se sincroniza con Siigo entra al
aprendizaje en un máximo de 5 minutos.

## Qué hace al crear el borrador
1. **IVA de cada renglón**
   - Si la empresa tiene un solo IVA con la tarifa del documento, toma ese.
   - Si hay varios IVA con la misma tarifa, toma el que se le usa a ese proveedor en
     Siigo.
   - Si el documento no trae la tarifa, solo usa el IVA histórico del proveedor
     cuando su tarifa cuadra al peso con el valor del renglón.
   - Si no hay precedente, el renglón queda para seleccionarlo, como hoy.
   - Con el IVA elegido, el asiento sale con la cuenta 2408 correcta.
2. **Retenciones que la factura no trae**
   - **Regla por proveedor** (Administración → Reglas por proveedor): manda siempre.
   - **Retención impresa en la factura:** se respeta.
   - **Condición confirmada** del proveedor (ver abajo): se aplica tal cual.
   - **Precedente en Siigo:** se practica con el mismo impuesto **solo si la base
     alcanza la base mínima** de su concepto. Si no la alcanza, el borrador explica
     por qué no se retuvo.
   - **Sin precedente de Retefuente:** el borrador queda **para revisión** y pide
     confirmar la condición del proveedor.

## Confirmar la condición del proveedor
En el editor del borrador, panel **"Condición tributaria del proveedor"**:

- **No se le retiene…** Elige el motivo (autorretenedor, régimen especial, no sujeto,
  gran contribuyente, no declarante u otro), un detalle opcional y qué retenciones
  no aplican.
- **Retenerle siempre con…** Elige el impuesto exacto de Retefuente, ReteIVA o
  ReteICA.

La condición queda guardada en el perfil del proveedor, con quién la confirmó y en
qué fecha, y se usa en todas sus facturas siguientes. Se puede quitar en cualquier
momento.

## Bases mínimas
Administración → **Bases mínimas**:

1. **Tablas con vigencia (comunes a todas las empresas):** cada tabla tiene fecha
   desde/hasta, UVT y conceptos con base en UVT y tarifas. Se escriben a mano o se
   **importan desde Excel** (columnas "Concepto", "Base UVT" o "Base en pesos",
   "Tarifa declarante", "Tarifa no declarante").
2. **Concepto de cada retención de la empresa:** asocia cada retención sincronizada
   de Siigo con su concepto. "Sugerir conceptos" lo propone por nombre y tarifa y
   solo sugiere cuando hay un único candidato claro. La pantalla muestra la base
   mínima en pesos.

Reglas de cálculo:
- **Base en pesos = base UVT × UVT, redondeada al múltiplo de mil más cercano**
  (art. 868 E.T.), como en la tabla de la firma: 10 UVT × $52.374 = $524.000.
- **Base 0** = se retiene sobre cualquier valor.
- Se practica la retención cuando la base de la factura es **igual o superior** a
  la base mínima.
- Para cada concepto manda la tabla **vigente en la fecha de la factura** que
  empezó más tarde. Así una excepción solo necesita los conceptos que cambian.

### Carga inicial 2026 (de `Tabla_Retencion_Fuente_2026_Octubre.pdf`)
- **Tabla general 2026** (1 de enero a 31 de diciembre de 2026): UVT $52.374,
  Decreto 572 de 2025, 50 conceptos verificados fila por fila contra el PDF (base
  en pesos y tarifa).
- **Excepción del 8 de mayo al 30 de junio de 2026** (suspensión provisional del
  Decreto 572): compras generales 27 UVT ($1.414.000) y servicios generales 4 UVT
  ($209.000). El documento solo indica esas bases; los demás conceptos siguen la
  tabla general.
- No incluye (tienen tablas propias): pagos laborales (art. 383 E.T.), dividendos,
  autorretención especial de renta y **ReteICA**. La ReteICA se sigue aplicando por
  precedente, sin verificación de base mínima, salvo que su retención tenga base
  fija configurada.

## Base de datos
- `retention_base_tables`: tablas legales con vigencia (globales), con la carga inicial 2026.
- `tax_rates.retention_concept`: concepto de cada retención de la empresa.
- `providers.purchase_tax_profile.condicion_retencion`: condición confirmada del proveedor.
