# Importador de compras desde Google Drive

Trae automáticamente las facturas de compra que la empresa deja en Google Drive
y las pasa por el mismo motor de causación de "Causar factura". Primera empresa:
LED LIGHTS S.A.S. (NIT 900.470.166-4).

## Qué hace

1. Una vez al día (6:00–6:45 p. m. hora Colombia) revisa, para cada empresa con
   carpeta configurada:
   `<carpeta raíz>/<año>/<N. MES>/FACTURAS/**` del **mes actual y el anterior**,
   incluidas las subcarpetas de proveedor (también las `1. PEND. - …`).
2. Cada PDF nuevo se guarda en Storage y entra a la **carga masiva**
   (`bulk_uploads` / `bulk_upload_items`) como una carga llamada
   `Google Drive · OCTUBRE 2026 / SEPTIEMBRE 2026 · fecha`.
3. Las facturas se leen y causan como borrador cuando algún usuario de la
   empresa abre la app (la carga masiva se retoma sola). **Nada se envía a Siigo
   sin aprobación.**
4. No vuelve a traer un archivo ya visto (por ID de Drive) ni un PDF idéntico ya
   cargado por ZIP o individual (huella SHA-256). Las facturas ya causadas se
   marcan como duplicadas por el motor (CUFE o NIT + prefijo + número).
5. Guarda la pista de pago del nombre del archivo (`Corriente16 - …`,
   `Efectivo08 - …`) en `drive_sync_files.payment_sources / payment_day`, para
   el cruce de egresos (fase 2). Si la usuaria renombra el archivo al pagarlo,
   la pista se actualiza en la siguiente revisión.

Solo lectura en Drive: no renombra, mueve ni borra nada. No importa todavía
`CUENTAS DE COBRO` (documentos soporte usan otro flujo) ni XML/ZIP.

## Configuración (una sola vez)

### 1. Credenciales de Google (Google Cloud Console)
1. https://console.cloud.google.com → crear proyecto (p. ej. "VC Causación").
2. APIs y servicios → Biblioteca → habilitar **Google Drive API** y
   **Google Sheets API**.
3. Pantalla de consentimiento OAuth → tipo *Externo* → agregar
   `vcaintegral@gmail.com` como usuario de prueba (o publicar la app).
4. Credenciales → Crear → *ID de cliente de OAuth* → *Aplicación web*.
   URI de redirección autorizado: `https://<URL-PUBLICADA-DE-LA-APP>/api/google/callback`
   (y la URL de vista previa de Lovable si se va a probar allí).
5. Copiar el *ID de cliente* y el *Secreto del cliente*.

> Si la app queda en modo "Prueba", Google vence el acceso cada 7 días y hay
> que reconectar. Para que no se venza, publicar la pantalla de consentimiento.

### 2. Secretos del servidor (Lovable → Cloud → Secrets)
| Nombre | Valor |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | ID de cliente del paso 1 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secreto del cliente del paso 1 |
| `DRIVE_SYNC_CRON_SECRET` | Una clave larga aleatoria inventada (mín. 32 caracteres) |
| `DRIVE_SYNC_MAX_FILES` | Opcional. PDF por pasada (20 por defecto) |

### 3. Base de datos
Aplicar la migración `drizzle/migrations/0019_drive_sync.sql` y luego ejecutar
`docs/importador-drive-cron.sql` con la URL publicada y el mismo
`DRIVE_SYNC_CRON_SECRET`.

### 4. En la app
1. Seleccionar la empresa LED LIGHTS → **Integraciones** → *Google Drive ·
   compras del mes* → **Conectar Google Drive** e iniciar sesión con
   `vcaintegral@gmail.com` (la cuenta que tiene la carpeta compartida).
2. Pegar el enlace de la carpeta raíz de la empresa
   (`https://drive.google.com/drive/folders/1kx_g1JlMujvuYrYZtNDXeudSu5g9OIMK`)
   → **Guardar carpeta**.
3. **Revisar ahora** para la primera importación y abrir **Causar factura** para
   ver la carga masiva en proceso.

## Tablas
- `google_drive_connections`: refresh token por empresa (solo servidor).
- `google_oauth_states`: estados de autorización de un solo uso (solo servidor).
- `drive_sync_sources`: carpeta raíz, activación y resultado de la última revisión.
- `drive_sync_files`: cada PDF visto, su estado (`queued` / `duplicate`), la
  tarea de carga masiva y la pista de pago.
