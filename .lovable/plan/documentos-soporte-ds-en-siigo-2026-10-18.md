# Documentos soporte (DS) en Siigo

## Qué verá Maira
- Nuevo menú **Documentos soporte** con 4 pestañas: Cargar · Borradores · Historial · Terceros por actualizar.
- Flujo: Cargar → Borradores → Aprobar → **Crear en Siigo (n)** → Historial, con los mismos estados de compras (Borrador, Incompleto, Aprobada, Sincronizando, Sincronizada, Error sin crear, Creado con diferencia, Envío interrumpido).
- Facturas de compra no cambian.

## 1. Carga
- **PDF / ZIP**: una tarea por PDF, lectura con IA (vendedor, identificación, fecha, número de cuenta de cobro, líneas). Montos en formato colombiano, en centavos.
- **Excel**: botón "Plantilla documentos soporte.xlsx" con las 15 columnas pedidas. NIT/CC y número como texto; filas con el mismo NIT/CC + número = un documento; errores por fila al subir.
- Reglas e historial se cargan una vez por carga, se procesan 5 a la vez, con barra "n de N" y tiempo transcurrido.
- Historial de cargas propio: archivo, leídos, creados, con error.

## 2. Cuentas y retenciones (mismo motor de compras)
- Regla por vendedor → historial del vendedor (DS-3 y FC-1) → historial por descripción → IA solo con cuentas 5, 6, 7, 15, 16, 17 → "Pendiente de cuenta".
- Candado: nunca 11, 12, 13, 21–28 o 4 como gasto. Origen visible debajo de cada cuenta.
- Alertas: "Definir si es declarante" (persona natural sin marca) y "Revisar: documento soporte con IVA" (exige confirmación).
- Al corregir una cuenta y aprobar, se guarda como regla del vendedor.
- Valores bloqueados; solo se editan cuenta, centro de costo y retención. Suma de líneas = total, débitos = créditos, ajuste ≤ $1 a 42958101, CxP = total − retenciones.

## 3. Terceros
- Antes de crear cada DS: buscar el vendedor en Siigo; si no existe, crearlo (CC 13, NIT 31 con DV, CE 22, Pasaporte 41; nombres/apellidos separados; "No responsable" salvo historial).
- Dirección, ciudad, departamento, país, teléfono y correo faltantes se toman de **Parámetros de la empresa** (nueva sección con los valores de Ballet que diste), se marcan "Dato tomado de la empresa" y el tercero entra en **Terceros por actualizar** (exportable a Excel).
- Si faltan identificación, tipo o nombre: queda **Incompleto** y no se crea.

## 4. Envío a Siigo
- Endpoint oficial: `POST /v1/purchase-support-documents`, tipo de comprobante desde `/v1/document-types?type=DS`. En Integraciones: selector "Tipo de comprobante documento soporte" (ej. DS-3).
- Se envía con `stamp: true` para que Siigo lo transmita a la DIAN.
- Antes: validaciones (vendedor completo, cuentas válidas, cuadre, fecha, duplicado vendedor + número + valor en la app y en Siigo), simulación del cálculo de Siigo, y confirmación en lote "Se crearán n documentos soporte en Siigo y Siigo los transmitirá a la DIAN. ¿Confirmar?".
- Después: se lee el documento en Siigo, se guarda el consecutivo DS y se compara total, retenciones y CxP. El estado de transmisión DIAN (si viene) va en una columna aparte.
- "Ver detalle" muestra el JSON enviado y la respuesta completa.

## 5. Errores y recuperación (igual que compras)
- Error sin crear: Reintentar envío (individual y en lote) y Volver a borrador.
- Creado con diferencia: Consultar Siigo de nuevo, Marcar como correcto (comentario obligatorio), Marcado como anulado en Siigo. Nunca reenvío ni borrado si tiene consecutivo.
- "Sincronizando" > 5 min → Envío interrumpido; antes de reintentar se busca en Siigo.
- Exportar comprobante como alternativa al envío.

## Detalles técnicos
- Se reutiliza la tabla de facturas con una marca de tipo de documento (`compra` / `soporte`) más columnas de vendedor (tipo de identificación, persona natural, declarante, campos tomados de la empresa). Así se heredan estados, valores de origen, asiento, eventos, trigger anti‑borrado y acciones de recuperación sin duplicar lógica. Las vistas de compras filtran por `compra`.
- Nueva tabla de parámetros por empresa (dirección, ciudad, departamento, país, teléfono, correo) y lista de terceros por actualizar.
- Nueva función de servidor `siigoSyncSupportDocument` que reutiliza resolución de terceros, retenciones, preflight y readback, cambiando solo el endpoint, `supplier_receipt_number` (prefijo ≤ 6, número de 11 dígitos con ceros a la izquierda) y `stamp`.
- El lector de Excel es puro (sin IA) y pasa por el mismo adaptador hacia la estructura de borrador; el PDF usa la extracción existente con un prompt de cuenta de cobro.
- Pruebas: agrupación del Excel, DV del NIT, candado de cuentas, duplicados vendedor+número+valor, cuadre y CxP.
- Prueba de aceptación con tu sesión: Excel de 10 documentos (3 vendedores nuevos), repetición detectada como duplicada. **No se creará ningún DS real en Siigo sin tu autorización**, porque Siigo los transmite a la DIAN.
