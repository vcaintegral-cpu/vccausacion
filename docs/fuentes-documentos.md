# Fuentes de documentos (compras y egresos automáticos)

Pestaña **Fuentes de documentos** (menú lateral). Por cada empresa se elige una
carpeta de **Compras** y otra de **Egresos**, en Google Drive o en OneDrive /
SharePoint. La app las revisa todos los días y trae solo lo nuevo, con el mismo
motor de "Causar factura". Empresas iniciales: LED LIGHTS (Google Drive) y
CORPORACIÓN BALLET FOLCLÓRICO DE ANTIOQUIA (OneDrive).

## Qué hace

1. Revisión diaria (6:00–6:45 p. m. hora Colombia) y botón **Revisar ahora**.
2. Organización de la carpeta:
   - Con subcarpetas por año y/o mes (`2026/10. OCTUBRE`, `OCTUBRE`, `10 - octubre`):
     toma el **mes actual y el anterior** por el nombre. Si hay dos carpetas para el
     mismo mes o falta una, lo advierte y no adivina.
   - Opcional: **subcarpeta dentro de cada mes** (p. ej. `FACTURAS`, `COMPRAS`, `PAGOS`).
   - Sin carpetas de mes: revisa la carpeta completa.
   - Incluye subcarpetas de proveedor (también las `1. PEND. - …`).
3. **Compras**
   - Cada PDF nuevo entra a la carga masiva y se lee con IA.
   - Cada Excel **RECIBIDOS** se lee sin IA: cada documento nuevo es una tarea
     propia. Si el Excel se reemplaza durante el mes, solo entran los documentos
     nuevos (se reconocen por número + CUFE). Un Excel de otra empresa no se carga.
   - Todo queda como **borrador**; la lectura y causación ocurren cuando un usuario
     de la empresa abre la app (la carga masiva se retoma sola).
4. **Egresos**
   - Soportes de pago (PDF) y extractos (PDF con "extracto" en el nombre, Excel o CSV)
     llegan a la **Bandeja de egresos**, donde se abren y se marcan como revisados o
     descartados. El cruce automático con las facturas es la siguiente fase.
5. Sin duplicados: no repite un archivo ya visto (ID de la fuente) ni uno idéntico ya
   cargado por ZIP o manualmente (huella SHA-256). Las facturas ya causadas las marca
   el motor como duplicadas (CUFE o NIT + prefijo + número).
6. Guarda la pista de pago del nombre del archivo (`Corriente16 - …`, `Efectivo08 - …`)
   para el cruce de egresos.

Solo lectura en Google Drive y OneDrive: no renombra, mueve ni borra nada. Nunca envía
nada a Siigo sin aprobación.

## Configuración (una sola vez)

### Google Drive (LED LIGHTS)
1. https://console.cloud.google.com → proyecto → habilitar **Google Drive API** y
   **Google Sheets API**.
2. Pantalla de consentimiento OAuth (Externo) → agregar `vcaintegral@gmail.com` como
   usuario de prueba, o publicarla (en modo prueba Google pide reconectar cada 7 días).
3. Credenciales → *ID de cliente de OAuth* → *Aplicación web* → URI de redirección:
   `https://<URL-PUBLICADA-DE-LA-APP>/api/oauth/callback`.

### OneDrive / SharePoint (BALLET)
1. https://entra.microsoft.com (administrador de Microsoft 365 de integralyasesores.com)
   → *Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro*.
2. Tipo de cuenta: *Solo este directorio organizativo*. URI de redirección (Web):
   `https://<URL-PUBLICADA-DE-LA-APP>/api/oauth/callback`.
3. *Permisos de API → Microsoft Graph → Delegados*: `openid`, `email`, `offline_access`,
   `User.Read`, `Files.Read.All` → **Conceder consentimiento de administrador**.
4. *Certificados y secretos → Nuevo secreto de cliente* (anotar la fecha de vencimiento).
5. Copiar el *Id. de aplicación (cliente)*, el secreto y el *Id. de directorio (inquilino)*.

### Secretos del servidor (Lovable → Cloud → Secrets)
| Nombre | Valor |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Credenciales de Google |
| `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` | Registro de Entra ID |
| `MICROSOFT_OAUTH_TENANT` | Id. de directorio (inquilino); si se omite, acepta cualquier cuenta de empresa |
| `DOCUMENT_SYNC_CRON_SECRET` | Clave larga aleatoria inventada (mín. 32 caracteres) |
| `DOCUMENT_SYNC_MAX_FILES` | Opcional. Archivos por carpeta y pasada (20 por defecto) |

### Base de datos
Aplicar `drizzle/migrations/0019_fuentes_documentos.sql` y ejecutar
`docs/fuentes-documentos-cron.sql` con la URL publicada y el mismo
`DOCUMENT_SYNC_CRON_SECRET`.

### En la app
1. Seleccionar la empresa → **Fuentes de documentos** → **Conectar** la cuenta
   (Google: `vcaintegral@gmail.com`; Microsoft: la cuenta con acceso a la carpeta).
2. Pegar el enlace de la carpeta de **Compras** y de **Egresos** (para OneDrive sirve
   el enlace copiado del navegador, `…/onedrive.aspx?id=/personal/…`, o "Copiar
   vínculo"), indicar la subcarpeta del mes si aplica y **Guardar carpeta**: la app
   confirma el nombre de la carpeta encontrada.
3. **Revisar ahora** para la primera importación.

## Tablas
- `document_connections`: refresh token por empresa y proveedor (solo servidor).
- `oauth_states`: autorizaciones pendientes de un solo uso (solo servidor).
- `document_sources`: carpeta de compras / egresos, subcarpeta del mes, activación y
  resultado de la última revisión.
- `document_source_files`: cada archivo visto, su estado (`queued`, `duplicate`,
  `received`, `error`), la tarea de carga masiva y la pista de pago.
- `payment_documents`: bandeja de egresos (soportes de pago y extractos).
