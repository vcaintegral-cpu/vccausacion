import { createFileRoute } from "@tanstack/react-router";

import { Correo, LEGAL, LegalPage, Seccion } from "@/components/legal-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: `Política de Privacidad — ${LEGAL.app}` },
      {
        name: "description",
        content: `Cómo ${LEGAL.app} de ${LEGAL.empresa} usa Google OAuth, qué datos de Google Drive lee y cómo protege la información.`,
      },
      { property: "og:title", content: `Política de Privacidad — ${LEGAL.app}` },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage titulo="Política de Privacidad">
      <p>
        {LEGAL.app} es una herramienta de {LEGAL.empresa} para la causación contable de facturas de compra y
        documentos de egreso de las empresas que la firma atiende. Esta política explica qué datos trata la
        aplicación, en especial los que obtiene de Google mediante Google OAuth, para qué los usa y cómo puede
        ejercer sus derechos.
      </p>

      <Seccion titulo="1. Responsable del tratamiento">
        <p>
          {LEGAL.empresa}. Contacto para cualquier asunto de privacidad: <Correo />. El tratamiento se hace conforme a
          la Ley 1581 de 2012 de Colombia y sus normas reglamentarias, y a la Política de Datos de Usuario de los
          Servicios de API de Google.
        </p>
      </Seccion>

      <Seccion titulo="2. Uso de Google OAuth">
        <p>
          Cuando un usuario conecta su cuenta de Google en la sección «Fuentes de documentos», la aplicación usa Google
          OAuth 2.0 y solicita estos permisos, todos de <strong>solo lectura</strong>:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>openid</strong> y <strong>email</strong>: identificar la cuenta de Google conectada y mostrar su
            correo.
          </li>
          <li>
            <strong>Google Drive, solo lectura</strong> (<code>drive.readonly</code>): listar y descargar los archivos
            de las carpetas que el usuario configura.
          </li>
          <li>
            <strong>Google Sheets, solo lectura</strong> (<code>spreadsheets.readonly</code>): leer hojas de cálculo
            con reportes de documentos recibidos, cuando estén en formato de Google Sheets.
          </li>
        </ul>
        <p>
          La aplicación <strong>nunca crea, modifica, mueve, comparte ni elimina</strong> archivos en Google Drive o
          Google Sheets. El usuario puede retirar el acceso en cualquier momento desde{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="font-medium text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>{" "}
          o desconectando la cuenta en la aplicación.
        </p>
      </Seccion>

      <Seccion titulo="3. Qué datos se leen">
        <ul className="list-disc space-y-1 pl-6">
          <li>
            Solo los archivos de las <strong>carpetas que el usuario indica</strong> para compras y egresos (y sus
            subcarpetas): no se recorre el resto de la cuenta.
          </li>
          <li>
            De esos archivos: nombre, identificador, tipo, fecha de modificación y ubicación dentro de la carpeta, y el
            contenido de las facturas en PDF, los reportes de documentos recibidos (Excel u hojas de cálculo), los
            soportes de pago y los extractos bancarios.
          </li>
          <li>
            De las facturas se extraen los datos necesarios para la contabilidad: emisor y comprador (razón social,
            NIT, dirección, teléfono, correo), número, fecha, CUFE, valores, impuestos, retenciones y detalle de los
            productos o servicios.
          </li>
          <li>El correo de la cuenta de Google conectada.</li>
        </ul>
        <p>
          Si la empresa conecta OneDrive o SharePoint en lugar de Google Drive, se aplican las mismas reglas con
          permisos de solo lectura de Microsoft.
        </p>
      </Seccion>

      <Seccion titulo="4. Para qué se usan">
        <p>
          Exclusivamente para prestar el servicio que el usuario solicita: importar los documentos de la carpeta,
          evitar duplicados, proponer el asiento contable, calcular retenciones y, cuando el usuario lo ordena, registrar
          el documento en el software contable de la empresa (por ejemplo Siigo). Los datos no se usan para publicidad,
          no se venden y no se usan para entrenar modelos de inteligencia artificial generalizados.
        </p>
      </Seccion>

      <Seccion titulo="5. No se comparten con terceros">
        <p>
          {LEGAL.empresa} <strong>no vende, alquila ni comparte</strong> los datos obtenidos de Google con terceros. Los
          datos solo pasan por los proveedores que hacen funcionar la aplicación y actúan por cuenta de la firma:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>La infraestructura de alojamiento y base de datos de la aplicación (Lovable Cloud).</li>
          <li>
            El servicio de lectura automática de documentos con inteligencia artificial, que recibe el contenido de cada
            factura únicamente para extraer sus datos contables.
          </li>
          <li>
            El software contable de la empresa (por ejemplo Siigo), solo cuando el usuario ordena causar o sincronizar un
            documento.
          </li>
        </ul>
        <p>
          También se entregarán datos si una autoridad competente lo exige conforme a la ley. El uso y la transferencia
          de la información recibida de las API de Google se ajusta a la{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="font-medium text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            Política de Datos de Usuario de los Servicios de API de Google
          </a>
          , incluidos los requisitos de Uso Limitado.
        </p>
      </Seccion>

      <Seccion titulo="6. Almacenamiento, seguridad y conservación">
        <ul className="list-disc space-y-1 pl-6">
          <li>
            Los documentos importados y los datos extraídos se guardan separados por empresa, con acceso solo para los
            usuarios autorizados de esa empresa.
          </li>
          <li>
            Las credenciales de acceso a Google (token de actualización) se guardan en el servidor, en un registro que
            solo el servidor puede leer: nunca se envían ni se muestran en el navegador.
          </li>
          <li>Las comunicaciones viajan cifradas (HTTPS).</li>
          <li>
            Los datos se conservan mientras la empresa use el servicio y durante el tiempo que exijan las normas
            contables y tributarias. Al desconectar la cuenta se deja de leer información de Google.
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="7. Derechos del titular">
        <p>
          Puede conocer, actualizar, rectificar y solicitar la supresión de sus datos, o revocar la autorización,
          escribiendo a <Correo />. Las consultas se responden en un máximo de diez (10) días hábiles y los reclamos
          en un máximo de quince (15) días hábiles, según la Ley 1581 de 2012.
        </p>
      </Seccion>

      <Seccion titulo="8. Cambios a esta política">
        <p>
          Si esta política cambia, se publicará aquí la nueva versión con su fecha de vigencia. Si el cambio amplía el
          uso de los datos de Google, se pedirá de nuevo la autorización del usuario.
        </p>
      </Seccion>

      <Seccion titulo="9. Contacto">
        <p>
          {LEGAL.empresa} · <Correo />
        </p>
      </Seccion>
    </LegalPage>
  );
}
