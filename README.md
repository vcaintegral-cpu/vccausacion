# InvoiceFlow AI

Nombre de la aplicación

Asistente Inteligente de Causación de Facturas de Compra

Objetivo

Crear una aplicación web con inteligencia artificial que automatice el proceso de contabilización de facturas de compra. El usuario únicamente cargará la factura (PDF o XML) y el sistema extraerá toda la información, propondrá el asiento contable y permitirá exportarlo o enviarlo directamente a Siigo o Contai.

Funcionalidades principales

1. Carga de documentos

Permitir cargar:

 PDF

 XML DIAN

 Imagen JPG

 PNG

También permitir arrastrar archivos.

2. Lectura inteligente (OCR + IA)

Extraer automáticamente:

 Número de factura

 Prefijo

 Fecha

 Fecha de vencimiento

 NIT proveedor

 Razón social

 Dirección

 Ciudad

 Teléfono

 Correo

 CUFE

 Forma de pago

 Medio de pago

 Moneda

 Centro de costos

 Observaciones 3. Lectura del detalle

Leer cada producto o servicio.

Extraer:

 Código

 Descripción

 Cantidad

 Valor unitario

 Descuento

 IVA

 Retención

 Impoconsumo

 Total

4. Validación con la DIAN

Si existe XML:

Validar:

 CUFE

 Estado

 Documento válido

 Documento rechazado

 Documento anulado

5. Validación de proveedores

Si el proveedor existe:

Utilizar su configuración.

Si no existe:

Crear automáticamente el tercero.

Solicitar únicamente:

 Régimen

 Actividad económica

6. Motor contable

La aplicación debe aprender la contabilización.

Ejemplo:

Proveedor Éxito

Siempre:

143505 Inventarios

2408 IVA descontable

220505 Proveedores

Proveedor Sura

Siempre:

5135 Seguros

220505

2408

La IA debe recordar futuras contabilizaciones. 7. Reglas contables

Configurar reglas.

Ejemplo

Si la factura contiene

"Computador"

llevar a

152405 Equipos de cómputo

Si contiene

"Papelería"

llevar a

519525 Papelería

Si contiene

"Restaurante"

llevar a

519595 Alimentación

8. Retenciones

Calcular automáticamente:

 Retefuente

 ReteIVA

 ReteICA

 IVA

 Autoretención

De acuerdo con:

 Tipo de proveedor

 Actividad

 Régimen

 Base mínima

 Tarifa vigente

Las tarifas deben poder actualizarse desde un panel de administración.9. Generación del comprobante

Crear automáticamente el asiento contable.

Ejemplo:

Débito

519525 Papelería

240801 IVA

Crédito

220505 Proveedores

Mostrar:

 Débitos

 Créditos

 Diferencias

10. Aprobación

Antes de contabilizar:

Mostrar la contabilización.

Botones:

 Editar

 Aprobar

 Rechazar

11. Integración con Siigo

Si el usuario tiene configurada la API:

Enviar automáticamente:

 Tercero

 Factura

 Comprobante

 Centro de costo

Mostrar:

"Factura enviada correctamente."12. Integración con Contai

Si Contai permite importación:

Generar automáticamente:

 Excel

 TXT

 CSV

Con el formato requerido por Contai.

13. Historial

Guardar:

 Factura original

 XML

 PDF

 Contabilización

 Usuario

 Fecha

 Hora

 Estado

14. Aprendizaje

Cada vez que el contador cambie una cuenta contable:

La IA debe aprender.

Ejemplo:

Proveedor

Makro

Siempre utilizar:

143505

Nunca volver a preguntar.

15. Panel administrativo

Permitir administrar:

 PUC

 Terceros

 Centros de costo

 Impuestos

 Retenciones

 Usuarios

 Empresas

 Reglas automáticas

 Historial de contabilizaciones

16. Empresas

Una sola aplicación para múltiples empresas.

Cada empresa tendrá:

 Su propio PUC.

 Sus propios terceros.

 Sus propias reglas.

 Sus propios impuestos.

 Sus propias retenciones.

 Sus credenciales de Siigo.

 Sus parámetros de Contai.7. Dashboard

Mostrar indicadores como:

 Facturas procesadas hoy.

 Facturas pendientes.

 Facturas con errores.

 Tiempo promedio de contabilización.

 Valor total contabilizado.

 IVA descontable.

 Retenciones practicadas.

 Compras por proveedor.

 Compras por centro de costos.

Arquitectura recomendada

 Frontend: Lovable.

 Base de datos: Supabase.

 OCR: Google Vision o Azure Document Intelligence.

 IA: OpenAI (GPT) para interpretar las facturas y proponer la contabilización.

 Integración con Siigo: API REST.

 Integración con Contai: Importación mediante archivos Excel, CSV o TXT (según el formato que utilice tu versión de Contai).

Recomendación adicional

Como eres contadora y buscas reducir al máximo el trabajo manual, te sugiero añadir un motor de parametrización contable. En lugar de depender únicamente de la IA, la aplicación debería permitir definir reglas por proveedor, tipo de gasto, palabras clave, NIT o concepto, para que el sistema aprenda la forma de contabilizar de cada empresa. Así, después de unas semanas de uso, la mayoría de las facturas podrían causarse automáticamente con una revisión mínima antes de enviarlas a Siigo o generar el archivo para Contai. Esto hará la aplicación más precisa, auditable y adaptable a distintos clientes.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://vccausacion.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/4bbbf2e5-d4c9-4e09-a6ee-4ab49f056873).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
