# Procesamiento masivo en segundo plano (backend)

Hoy el ZIP se procesa dentro del navegador: si el usuario sale de "Causar factura", el lote se detiene. El objetivo es que la base de datos guarde la cola, el backend ejecute los trabajos y la pantalla solo muestre el avance.

## 1. Cola persistente de trabajos

Nueva tabla `processing_jobs` con: `job_id`, `job_type` (`document_processing`, `accounting_generation`, `siigo_sync`), `upload_id`, `item_id`, `invoice_id`, `company_id`, `file_name`, `storage_bucket`, `storage_path`, `status`, `processing_stage`, `priority`, `attempt_count`, `max_attempts` (3), `locked_at`, `locked_by`, `error_code`, `error_message`, `ai_result` (JSON), y marcas de tiempo.

Estados: `pending, processing, reading, extracting_data, accounting, ready_for_review, approved, syncing_siigo, synchronized, error, duplicate, cancelled`.

Funciones en base de datos:
- `claim_jobs(worker_id, limit)`: toma trabajos `pending` de forma atómica (`FOR UPDATE SKIP LOCKED`) y los marca `processing` con `locked_at`/`locked_by`. Dos workers nunca toman el mismo trabajo.
- `release_stale_jobs()`: devuelve a `pending` los trabajos con `locked_at` mayor a 5 minutos, sin crear trabajos nuevos y sin superar `max_attempts`.
- `cancel_upload_jobs(upload_id)` / `resume_upload_jobs(upload_id)`.

## 2. Worker en el backend

Nueva ruta pública `POST /api/public/jobs/run` (protegida por un secreto de servicio) que:
1. libera trabajos vencidos,
2. reclama hasta N trabajos (concurrencia configurable, por defecto 3),
3. procesa cada uno y actualiza estado y etapa en la base de datos,
4. responde cuántos quedan pendientes.

Se dispara desde dos lados, sin depender de la pantalla:
- `pg_cron` cada minuto (mientras haya trabajos pendientes),
- un "empujón" único al terminar de subir el ZIP, para que arranque de inmediato.

## 3. Reutilizar la misma lógica de causación

No se crea una segunda lógica contable. Se hace un cambio mecánico: el motor de causación y el procesador de facturas reciben el cliente de base de datos como parámetro en lugar de importar el del navegador. La factura individual sigue usando exactamente las mismas funciones y su comportamiento no cambia.

## 4. Lectura del PDF en el servidor

- PDF con texto digital (la mayoría de facturas DIAN): se extrae el texto en el servidor con pdfjs sin renderizar, y se envía a la IA igual que hoy.
- PDF escaneado (sin capa de texto): el servidor no puede renderizar imágenes. Ese trabajo queda en estado `needs_ocr` y se procesa cuando el módulo de causación esté abierto (el navegador convierte las páginas y devuelve el resultado). El resto del lote continúa en el backend sin bloquearse.

## 5. Créditos de IA

Una sola llamada a IA por intento válido. El resultado se guarda en `ai_result`; si un trabajo se reintenta y ya tiene lectura guardada, se reutiliza y no se vuelve a llamar a la IA salvo que el usuario pida "reprocesar" explícitamente.

## 6. Siigo independiente

`siigo_sync` es un tipo de trabajo aparte, con su propia cola; una factura aprobada se envía aunque el ZIP siga procesando. Antes de enviar se verifica `siigo_status`, número, proveedor y CUFE: si ya está `synchronized`, no se reenvía. Se separan `accounting_status` y `siigo_status`.

## 7. Interfaz

- Nueva sección **Procesos en segundo plano** (ruta `/procesos`) con la tabla PROCESO | TIPO | TOTAL | PROCESADAS | ERROR | PENDIENTES | ESTADO, indicadores globales (activos, en cola, procesando, errores, sincronizadas) y botones Cancelar / Reanudar / Reintentar errores / Eliminar.
- En "Causar factura", el bloque masivo pasa a ser solo lectura del estado real: sube el ZIP, crea los trabajos y muestra el avance consultado desde la base de datos (refresco cada pocos segundos). Ningún contador local es fuente de verdad.
- Historial por ZIP: fecha, usuario, empresa, PDF encontrados, procesadas, errores, duplicadas, sincronizadas, duración y estado final.

## 8. Pruebas

2 facturas, salir del módulo y volver, recargar el navegador, factura individual + Siigo mientras corre el ZIP, ZIP de 5 y ZIP de 28.

## No se toca

PUC, productos, categorías, impuestos, retenciones, centros de costo, reglas, aprendizaje, lectura y causación individual, aprobación y la integración actual con Siigo.
