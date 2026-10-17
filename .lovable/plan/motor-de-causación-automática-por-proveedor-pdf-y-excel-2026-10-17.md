# Motor de causación automática por proveedor (PDF y Excel)

Objetivo: que "Causar factura" asigne automáticamente cuenta de gasto, IVA, INC, retenciones y CxP por proveedor, dejando cada borrador cuadrado y listo para aprobar. No se toca la lectura de PDF con IA, "Renglón manual", la pantalla de Borradores ni los botones Aprobar / Causar / Causar en Siigo / Revertir.

## 1. Tabla "Reglas por proveedor" (nueva)

- Nueva tabla `provider_rules` por empresa: NIT, palabra clave, cuenta de gasto, tratamiento de IVA (Descontable / Asumido / Capitalizado / N/A), cuenta IVA, cuenta INC, cuenta de retención, tarifa, base (Subtotal / AIU), cuenta CxP. Con permisos y seguridad por empresa como las demás tablas.
- Pantalla editable en Administración con importación y exportación en Excel.
- Carga inicial de las 15 reglas de CORPORACION BALLET FOLCLORICO DE ANTIOQUIA (NIT 800212838): Neuron, VC Integral, Atila, Televigia, Suramericana, UNE EPM (MORA y todas), Comcel, EPM (AGUA / ALCANTARILLADO / ENERG / todas), Inversiones de Paso, Bernardo Usuga, Departamento de Antioquia (CERTIF y todas).

## 2. Motor de cuentas (mismo para PDF y Excel)

Por cada línea, en orden de prioridad:
- P1: regla del proveedor con palabra clave contenida en la descripción (sin mayúsculas ni tildes).
- P2: regla del proveedor con palabra clave "(todas)".
- P3: historial aprendido del mismo NIT con descripción similar.
- P4: cuenta de gasto más frecuente del mismo NIT en los últimos 12 meses.
- P5: estado "Pendiente de cuenta" en rojo (nunca "—" sin estado).
- Validación obligatoria: la cuenta de gasto solo puede empezar por 5, 6, 7, 15, 16 o 17; si una sugerencia cae en 11, 13, 22, 23 o 24 se descarta y pasa a la siguiente prioridad.
- Líneas agrupadas por cuenta + centro de costo (el centro de costo se sugiere como hoy).

## 3. Asiento del borrador

- Débitos: gasto por línea (subtotal neto de descuento), IVA según tratamiento del proveedor (Descontable → 24081013 o cuenta de la regla; Asumido → 51157001; Capitalizado → se suma a la cuenta de la línea), INC a la cuenta de la regla o 51158101.
- Créditos: retención con cuenta/tarifa/base de la regla (base Subtotal = líneas sin IVA; base AIU = líneas cuya descripción contiene ADMINISTRACION, UTILIDAD, IMPREVISTOS o AIU); cruce de anticipo si el proveedor tiene saldo débito en 13300501, por el menor entre saldo y total a pagar, marcado "Confirmar cruce de anticipo"; CxP de la regla por TOTAL − retenciones − anticipo.
- Cuadre: diferencia ≤ $1 va a 42958101 Ajuste al peso; diferencia > $1 deja el borrador "No cuadra" y no se puede aprobar.
- Alerta sin bloqueo "Retención difiere del documento" comparando contra RETE RENTA del XML/Excel.

## 4. Aprendizaje desde Siigo

- En Aprendizaje contable: opción "Importar Comprobantes detallados de Siigo (.xlsx)" (encabezados en fila 8).
- Aprende solo de comprobantes FC-1 y DS-3; ignora RP, RC, FV, CC, NC, ND y TD.
- Por comprobante y NIT aprende: gasto (débitos de grupos 5, 6, 7, 15, 16, 17 excepto 51157001), IVA (24081013 descontable / 51157001 asumido / capitalizado si es grupo 15 sin línea de IVA), retención (2365xx con tarifa del nombre y base del detalle), CxP (crédito 2205 o 2335). Guarda frecuencia y último uso (prioridades P3/P4).
- Al corregir y aprobar un borrador, la corrección se guarda como regla P1 para ese NIT y descripción.

## 5. Validaciones antes de Aprobar

Bloqueantes (con motivo exacto en la fila, ej. "Falta cuenta de gasto línea 2"):
- Todas las líneas con cuenta de gasto válida (5, 6, 7, 15, 16, 17).
- IVA con tratamiento.
- Cuenta CxP presente.
- Débitos = créditos al peso.
- Suma de líneas = subtotal de la factura.

Sin bloqueo: "Posible gasto de periodo anterior", "Retención difiere del documento", "Confirmar cruce de anticipo".

## 6. Botón "Recalcular cuentas (n)" en Borradores

Aplica el motor a los borradores seleccionados sin borrar los datos de la factura.

## 7. Verificación

- Prueba con los 17 borradores de septiembre 2026 de Ballet: esperado 14 cuadrados y 3 en "Pendiente de cuenta" (Sayco, Extintores, Zuluaga); ningún borrador con 11200502 ni 22050501 como gasto.
- El mismo documento por PDF y por Excel debe generar el mismo comprobante.
- El flujo .zip de PDF sigue igual.

## Detalles técnicos

- Migración nueva para `provider_rules` (con GRANTs y RLS por empresa); las 15 reglas iniciales se cargan con SQL de datos para la empresa Ballet.
- Motor en `src/lib/provider-rules.ts` + cambios acotados en `src/lib/accounting.ts` (buildJournal) y `src/lib/bulk-invoices.ts` (saveExtractedInvoice), reutilizados por PDF y Excel sin tocar la extracción IA.
- Importador Siigo en `src/lib/siigo-learning.ts` usando SheetJS; UI en `aprendizaje.tsx`.
- Validaciones de aprobación en `borradores.tsx`/`revisar.tsx` sin cambiar los botones existentes.
- Memoria del proyecto actualizada con las reglas contables nuevas.
