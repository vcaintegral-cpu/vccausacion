import { createFileRoute, Link } from "@tanstack/react-router";

import { Correo, LEGAL, LegalPage, Seccion } from "@/components/legal-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: `Términos del Servicio — ${LEGAL.app}` },
      {
        name: "description",
        content: `Condiciones de uso de ${LEGAL.app}, la herramienta de causación contable de ${LEGAL.empresa}.`,
      },
      { property: "og:title", content: `Términos del Servicio — ${LEGAL.app}` },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage titulo="Términos del Servicio">
      <p>
        Estos términos regulan el uso de {LEGAL.app}, herramienta de {LEGAL.empresa} para la causación de facturas de
        compra y documentos de egreso. Al usar la aplicación, el usuario acepta estos términos y la{" "}
        <Link to="/privacy" className="font-medium text-primary underline underline-offset-2">
          Política de Privacidad
        </Link>
        .
      </p>

      <Seccion titulo="1. El servicio">
        <p>
          La aplicación lee facturas y reportes de documentos (cargados por el usuario o tomados de las carpetas de
          Google Drive, OneDrive o SharePoint que el usuario autoriza), propone el asiento contable con sus impuestos y
          retenciones y, cuando el usuario lo ordena, lo registra en el software contable de la empresa.
        </p>
      </Seccion>

      <Seccion titulo="2. Cuentas y acceso">
        <ul className="list-disc space-y-1 pl-6">
          <li>El acceso es solo para usuarios autorizados por {LEGAL.empresa}.</li>
          <li>Cada usuario es responsable de la confidencialidad de su contraseña y de la actividad en su cuenta.</li>
          <li>
            Al conectar Google u otra cuenta de almacenamiento, el usuario declara que está autorizado para dar acceso a
            esas carpetas y a los documentos que contienen.
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="3. Responsabilidad sobre la información contable">
        <p>
          La lectura automática y las propuestas de causación son una ayuda. El usuario debe revisar y aprobar cada
          comprobante antes de registrarlo; la aplicación no reemplaza el criterio profesional del contador. La
          exactitud final de los registros contables y tributarios es responsabilidad de quien los aprueba.
        </p>
      </Seccion>

      <Seccion titulo="4. Uso aceptable">
        <p>
          No se permite usar la aplicación para fines ilícitos, cargar documentos sin autorización de su titular,
          intentar acceder a datos de otras empresas o afectar el funcionamiento del servicio.
        </p>
      </Seccion>

      <Seccion titulo="5. Servicios de terceros">
        <p>
          La aplicación se conecta con servicios de terceros (Google, Microsoft, Siigo y otros). Su uso también se rige
          por los términos de esos proveedores. {LEGAL.empresa} no responde por interrupciones o cambios de esos
          servicios.
        </p>
      </Seccion>

      <Seccion titulo="6. Disponibilidad">
        <p>
          Se procura mantener el servicio disponible y seguro, pero puede tener interrupciones por mantenimiento o
          causas ajenas. El servicio se ofrece en el estado en que se encuentra, sin más garantías que las previstas
          por la ley.
        </p>
      </Seccion>

      <Seccion titulo="7. Terminación">
        <p>
          El usuario puede dejar de usar la aplicación y desconectar sus cuentas en cualquier momento. {LEGAL.empresa}{" "}
          puede suspender el acceso ante un uso contrario a estos términos.
        </p>
      </Seccion>

      <Seccion titulo="8. Cambios y ley aplicable">
        <p>
          Estos términos pueden actualizarse; la nueva versión se publicará aquí con su fecha de vigencia. Se rigen por
          las leyes de la República de Colombia.
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
