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

1. **Tabla del año (común a todas las empresas):** valor de la UVT y conceptos con
   su base en UVT y sus tarifas. Se puede escribir a mano o **importar desde Excel**,
   con columnas "Concepto", "Base UVT" o "Base en pesos", "Tarifa declarante" y
   "Tarifa no declarante".
2. **Concepto de cada retención de la empresa:** asocia cada retención sincronizada
   de Siigo con su concepto ("Sugerir conceptos" lo propone por nombre y tarifa) y
   muestra su base mínima en pesos.

La base mínima se calcula con la UVT del **año de la factura**. Si una retención no
tiene concepto ni base mínima propia, se practica y el borrador avisa que no se
verificó la base.

## Base de datos
- `retention_base_tables`: tabla legal por año (global).
- `tax_rates.retention_concept`: concepto de cada retención de la empresa.
- `providers.purchase_tax_profile.condicion_retencion`: condición confirmada del proveedor.
