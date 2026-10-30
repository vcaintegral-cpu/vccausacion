# Compras desde Excel RECIBIDOS
- [x] Recuperación con formulario de solo correo, resultados persistentes y reintento; enlace vencido bloqueado, pruebas de pantalla con respuestas simuladas sin errores.
- [ ] Comprobar entrega real del correo y cambio de contraseña: requiere que Maira solicite el enlace y lo abra; no se cambió su contraseña.
- [ ] Envío DS en lote: comprobar configuración actual; confirmar prueba guardada sin transmisión DIAN antes de habilitar.
- [x] Acciones persistentes para Error Siigo: sin crear (Reintentar/Volver a borrador), creado con diferencia (Consultar de nuevo/Marcar correcto/Marcado anulado), envíos interrumpidos >5 min con búsqueda en Siigo, detalle completo, filtros y lote, eliminación bloqueada con consecutivo. FE-3482 consultada de nuevo: pasó a Sincronizada.
- [x] Corregir omisión de INC porcentual, validar importes desde la precisión enviada y eliminar tarifas IVA globales inferidas; reconstruir total bruto del readback con retenciones y conservar bloqueo de reenvíos. TELEVIGIA comprobada con sesión real: bloqueada antes del POST por IVA 4.968 frente a cálculo 49.679,68.
- [ ] Resolver documentos ya creados con diferencias reales (FC-1-684, 688, 692, 696, 698, 700): la usuaria decide en Siigo y usa Consultar de nuevo / Marcar correcto / Marcado anulado; nunca reenvío.
- [x] Representación Siigo sin cambiar importes: IVA sobre base parcial dividida (TELEVIGIA), INC sin impuesto como mayor costo (COMCEL), retefuente solo en renglón AIU (ATILA), ajuste al peso como renglón (+) o descuento en renglón no gravado (−) (UNE, EPM). Enviadas y verificadas: F-105382, FOPU-235005, AT-7796, E-6103023639, DEE-61768892 (FC-1-712; Siigo ignora items[].discount, el ajuste negativo se resta del valor de un renglón sin IVA).
- [ ] FE-2992 (VC INTEGRAL) ajuste −0,40 sin renglón no gravado: Siigo no admite representarlo sin cambiar valores; requiere decisión de la usuaria.
- [ ] Resolver rechazo documents_service de BUF-1277: Ballet nunca ha enviado la cuenta 15160501 ni la retención 21434 (RTE 2% construcción); requiere verificación en Siigo por la usuaria.
- [x] Habilitar RECIBIDOS en el envío compartido a Siigo, con validaciones de fuente/cuentas/CUFE y verificación posterior de total/IVA/INC/retenciones/CxP; 42 pruebas aprobadas y prueba real ejecutada para AT-7796 y FE-2992, ambas bloqueadas antes de crear por diferencias.
- [x] Resolver IVA de fuente sin identificador seleccionado y falso gasto inválido del ajuste documental; UNE guardada y reabierta con IVA 32.458,49 y total 218.310,00 sin esas alertas; 40 pruebas aprobadas.
- [x] Corregir el congelamiento al abrir la factura UNE: índice compartido de cuentas y resultados acotados; pruebas contables y búsqueda/navegación con sesión real verificadas.
- [x] Preservar importes de fuente y corregir descuento duplicado/redistribución PDF; 17 borradores recuperados del Excel original.
- [x] Proteger valores y aprobación, conciliación y correcciones auditadas.
- [x] Validar exportación Contai y controles previos/posteriores Siigo, bloqueando diferencias y reenvíos de documentos ya creados.
- [x] Pruebas monetarias y comprobación del flujo visible; 17 documentos suman 23.759.319,12 y conciliación sin diferencias.
- [ ] Completar creación y lectura posterior Siigo de AT-7796 y FE-2992: ATILA no tiene IVA exacto identificado (tarifa global 1,73% no corresponde al IVA AIU); VC INTEGRAL tiene ajuste documental 0,40 sin representación admitida por el mapeo PDF actual. No alterar valores ni inventar impuestos para enviarlas.
- [ ] Verificar importación en Contai: requiere acceso al programa destino; archivo y centavos comprobados localmente.
- [x] Bloquear cuentas bancarias/CxP como gasto, incluyendo borradores existentes.
- [x] Priorizar historial por NIT y descripción, con origen visible y filtro.
- [x] Precargar conocimiento por lote, procesar cinco en paralelo y guardar por grupo; progreso con tiempo.
- [x] Recalcular sin releer archivos, índices y verificación con las 17 compras.
- [x] Lectura de ambas hojas sin IA y validaciones del XML.
- [x] Parámetros por empresa y marcas tributarias por proveedor.
- [x] Revisión, cálculos, cuentas, anticipos y notas crédito.
- [x] Persistencia independiente por documento, historial y exportación Contai; envío compartido a Siigo habilitado con validaciones bloqueantes.
- [x] Pruebas con el archivo aportado y flujo en pantalla.
- [x] Metadatos de pantallas y actualización de seguridad obligatoria.- [x] FE-2992 enviada con diferencia de redondeo pendiente al pago (FC-1-714); lista "Pendientes Siigo".
- [x] BUF-1277 enviada como gasto 5145 (FC-1-726); anticipo en Pendientes Siigo.
- [x] Documentos soporte: carga PDF/ZIP/Excel, borradores, aprobación, envío a Siigo, recuperación, terceros por actualizar.
- [ ] Primer DS real en Siigo: espera autorización de Maira y el tipo de comprobante DS en Configuración.

## Documentos soporte – ventana de fechas y resolución (hecho 2026-10-18)
- Ventana Siigo configurable (ds_window_days=10, ds_date_ref=fin_mes|hoy); fecha fuera de ventana se propone y requiere confirmación (individual y lote); nunca cambia sola.
- invalid_date: lote se detiene, botón "Reintentar con el último día del mes" con confirmación; fechas intentadas en siigo_trace.fechas_intentadas; ds_sent_date guardada y visible en Borradores/Detalle/Historial.
- Número de documento = solo cuenta de cobro; sin número: alerta, no se aprueba, editor inline; borrador de Natalia Garcés quedó incompleto para escribir el número.
- Estado DIAN: 3 etiquetas + contador "n de 6" con alerta roja ≤2 días + filtro "Pendientes de envío DIAN".
- Resoluciones de numeración (tabla ds_resolutions): varias sin borrar, aviso 30 días antes del vencimiento, bloqueo por vencimiento o consecutivo máximo.
- CxP por defecto DS (ds_payable_account=23359501) con prioridad al historial del vendedor.
- Pendiente: Maira debe escribir el número de cuenta de cobro del borrador de Natalia y reenviar (confirmará fecha 20/09/2026).
- [x] DS: crear solo guardado en Siigo (stamp/mail send=false), detectar transmisión no autorizada y detener lote; 1 por vez hasta confirmar prueba.
- [ ] DS: primera prueba segura (1 documento) la crea Maira y confirma en Siigo "Documento guardado"; luego habilita lote en Configuración.

## Importador desde Google Drive (LED LIGHTS)
- [x] Fase 1: conexión OAuth de solo lectura, carpeta raíz por empresa, recorrido <año>/<N. MES>/FACTURAS/** del mes actual y el anterior, PDF nuevos a la carga masiva, sin duplicar por ID de Drive ni huella; pista de pago del nombre ("Corriente16 - "); revisión diaria (pg_cron) y botón "Revisar ahora". Pruebas con la estructura real de octubre 2026.
- [ ] Configurar credenciales Google, secretos, migración 0019 y docs/importador-drive-cron.sql (ver docs/importador-drive.md).
- [ ] Fase 2: egresos — cruzar movimientos sin comprobante del Google Sheets del mes (Cte. (W), Ahorros, Davivienda, Efectivo) con facturas por NIT + valor exacto + pista de pago y proponer comprobante de pago en borrador; dudosos a alertas.
- [ ] Fase 3: causación en servidor para que no dependa de abrir la app.
- [ ] Documentos soporte desde CUENTAS DE COBRO.
