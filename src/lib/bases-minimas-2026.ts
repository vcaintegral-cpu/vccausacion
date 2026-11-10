// Tabla de Retención en la Fuente 2026 (VC Integral & Asesores SAS, vigente al
// 31 de octubre de 2026): UVT 2026 = $52.374, Decreto 572 de 2025.
// Fuente: Tabla_Retencion_Fuente_2026_Octubre.pdf. Es la carga inicial de
// retention_base_tables (migración 0019); después se edita en Administración →
// Bases mínimas.
import type { ConceptoBase, TablaBases } from "@/lib/precedente-tributario";

export const UVT_2026 = 52374;
const FUENTE = "Tabla_Retencion_Fuente_2026_Octubre.pdf (VC Integral & Asesores SAS)";

/** Un concepto con una sola tarifa (aplica igual a declarantes y no declarantes). */
const c = (id: string, concepto: string, base_uvt: number, tarifa: number): ConceptoBase => ({
  id,
  concepto,
  base_uvt,
  tarifa_declarante: tarifa,
  tarifa_no_declarante: tarifa,
});
/** Fila exclusiva de declarantes. */
const d = (id: string, concepto: string, base_uvt: number, tarifa: number): ConceptoBase => ({
  id,
  concepto,
  base_uvt,
  tarifa_declarante: tarifa,
  tarifa_no_declarante: null,
});
/** Fila exclusiva de no declarantes. */
const n = (id: string, concepto: string, base_uvt: number, tarifa: number): ConceptoBase => ({
  id,
  concepto,
  base_uvt,
  tarifa_declarante: null,
  tarifa_no_declarante: tarifa,
});

/** Solo base, sin tarifa. */
const b = (id: string, concepto: string, base_uvt: number): ConceptoBase => ({
  id,
  concepto,
  base_uvt,
  tarifa_declarante: null,
  tarifa_no_declarante: null,
});

export const CONCEPTOS_2026: ConceptoBase[] = [
  // COMPRAS
  d("compras_generales_declarantes", "Compras generales (declarantes)", 10, 2.5),
  n("compras_generales_no_declarantes", "Compras generales (no declarantes)", 10, 3.5),
  c("compras_tarjeta", "Compras con tarjeta débito o crédito", 0, 1.5),
  c(
    "agricolas_sin_procesamiento",
    "Compras de bienes o productos agrícolas o pecuarios sin procesamiento industrial",
    70,
    1.5,
  ),
  d(
    "agricolas_con_procesamiento_declarantes",
    "Compras de bienes o productos agrícolas o pecuarios con procesamiento industrial (declarantes)",
    10,
    2.5,
  ),
  n(
    "agricolas_con_procesamiento_no_declarantes",
    "Compras de bienes o productos agrícolas o pecuarios con procesamiento industrial (no declarantes)",
    10,
    3.5,
  ),
  c("cafe_pergamino_cereza", "Compras de café pergamino o cereza", 70, 0.5),
  c("combustibles", "Compras de combustibles derivados del petróleo", 0, 0.1),
  c(
    "activos_fijos_personas_naturales",
    "Enajenación de activos fijos de personas naturales (notarías y tránsito son agentes retenedores)",
    0,
    1,
  ),
  c("vehiculos", "Compras de vehículos", 0, 1),
  c(
    "oro_sociedades_ci",
    "Compra de oro por las sociedades de comercialización internacional",
    0,
    2.5,
  ),
  c(
    "bienes_raices_vivienda_primeras_10000_uvt",
    "Compras de bienes raíces cuya destinación y uso sea vivienda de habitación (por las primeras 10.000 UVT)",
    10,
    1,
  ),
  c(
    "bienes_raices_vivienda_exceso_10000_uvt",
    "Compras de bienes raíces cuya destinación y uso sea vivienda de habitación (exceso de las primeras 10.000 UVT)",
    10000,
    2.5,
  ),
  c(
    "bienes_raices_otros_usos",
    "Compras de bienes raíces cuya destinación y uso sea distinto a vivienda de habitación",
    10,
    2.5,
  ),
  // SERVICIOS
  d("servicios_generales_declarantes", "Servicios generales (declarantes)", 2, 4),
  n("servicios_generales_no_declarantes", "Servicios generales (no declarantes)", 2, 6),
  d("emolumentos_eclesiasticos_declarantes", "Por emolumentos eclesiásticos (declarantes)", 10, 4),
  n(
    "emolumentos_eclesiasticos_no_declarantes",
    "Por emolumentos eclesiásticos (no declarantes)",
    10,
    3.5,
  ),
  c("transporte_carga", "Servicios de transporte de carga", 2, 1),
  d(
    "transporte_pasajeros_terrestre_declarantes",
    "Servicios de transporte nacional de pasajeros por vía terrestre (declarantes)",
    10,
    3.5,
  ),
  n(
    "transporte_pasajeros_terrestre_no_declarantes",
    "Servicios de transporte nacional de pasajeros por vía terrestre (no declarantes)",
    10,
    3.5,
  ),
  c(
    "transporte_pasajeros_aereo_maritimo",
    "Servicios de transporte nacional de pasajeros por vía aérea o marítima",
    2,
    1,
  ),
  c(
    "servicios_temporales_aiu",
    "Servicios prestados por empresas de servicios temporales (sobre AIU)",
    2,
    1,
  ),
  c(
    "vigilancia_aseo_aiu",
    "Servicios prestados por empresas de vigilancia y aseo (sobre AIU)",
    2,
    2,
  ),
  c("salud_ips", "Servicios integrales de salud prestados por IPS", 2, 2),
  d(
    "hoteles_restaurantes_declarantes",
    "Servicios de hoteles y restaurantes (declarantes)",
    2,
    3.5,
  ),
  n(
    "hoteles_restaurantes_no_declarantes",
    "Servicios de hoteles y restaurantes (no declarantes)",
    2,
    3.5,
  ),
  c("construccion_urbanizacion", "Contratos de construcción y urbanización", 10, 2),
  // ARRENDAMIENTOS
  c("arrendamiento_muebles", "Arrendamiento de bienes muebles", 0, 4),
  d(
    "arrendamiento_inmuebles_declarantes",
    "Arrendamiento de bienes inmuebles (declarantes)",
    10,
    3.5,
  ),
  n(
    "arrendamiento_inmuebles_no_declarantes",
    "Arrendamiento de bienes inmuebles (no declarantes)",
    10,
    3.5,
  ),
  // HONORARIOS, COMISIONES Y SOFTWARE
  c("honorarios_personas_juridicas", "Honorarios y comisiones (personas jurídicas)", 0, 11),
  d(
    "honorarios_personas_naturales_3300_uvt_declarantes",
    "Honorarios y comisiones pagados a personas naturales que suscriban contratos por más de 3.300 UVT o que la sumatoria de los pagos o abonos en cuenta durante el año gravable superen 3.300 UVT (declarantes)",
    0,
    11,
  ),
  n("honorarios_no_declarantes", "Honorarios y comisiones (no declarantes)", 0, 10),
  c("licenciamiento_software", "Servicios de licenciamiento o derecho de uso de software", 0, 3.5),
  // RENDIMIENTOS FINANCIEROS
  c("rendimientos_financieros", "Intereses o rendimientos financieros", 0, 7),
  c("titulos_renta_fija", "Rendimientos financieros provenientes de títulos de renta fija", 0, 4),
  // OTROS CONCEPTOS
  d("otros_ingresos_declarantes", "Otros ingresos tributarios (declarantes)", 10, 2.5),
  n("otros_ingresos_no_declarantes", "Otros ingresos tributarios (no declarantes)", 10, 3.5),
  c("loterias_rifas_apuestas", "Loterías, rifas, apuestas y similares", 48, 20),
  c("juegos_suerte_azar", "Retención en colocación independiente de juegos de suerte y azar", 5, 3),
  // RETENCIÓN EN LA FUENTE POR IVA (RETEIVA)
  c("reteiva_servicios", "Retención en la fuente por IVA en servicios", 2, 15),
  c("reteiva_compras", "Retención en la fuente por IVA en compras", 10, 15),
  // RETENCIÓN POR PAGOS AL EXTERIOR
  c(
    "exterior_intereses_regalias_servicios",
    "Exterior: intereses, comisiones, honorarios, regalías, arrendamientos, servicios personales, propiedad industrial, know-how, prestación de servicios, propiedad literaria, artística y científica, películas y software",
    0,
    20,
  ),
  c(
    "exterior_consultoria_asistencia_tecnica",
    "Exterior: consultorías, servicios técnicos y de asistencia técnica prestados por no residentes o no domiciliados",
    0,
    20,
  ),
  c(
    "exterior_rendimientos_creditos_leasing",
    "Exterior: rendimientos financieros de créditos en el exterior a 1 año o más, e intereses o costos financieros del canon de leasing con empresas extranjeras sin domicilio en Colombia",
    0,
    15,
  ),
  c(
    "exterior_leasing_naves_aerodinos",
    "Exterior: contratos de leasing sobre naves, helicópteros y/o aerodinos y sus partes con empresas extranjeras sin domicilio en Colombia",
    0,
    1,
  ),
  c(
    "exterior_app_infraestructura_8_anios",
    "Exterior: rendimientos o intereses de créditos a 8 años o más para proyectos de infraestructura bajo Asociaciones Público-Privadas (Ley 1508 de 2012)",
    0,
    5,
  ),
  c(
    "exterior_reaseguros",
    "Exterior: prima cedida por reaseguros a no residentes o no domiciliados",
    0,
    1,
  ),
  c(
    "exterior_administracion_art124",
    "Exterior: administración o dirección del artículo 124 del Estatuto Tributario a no residentes o no domiciliados",
    0,
    33,
  ),
];

/** Tabla general 2026 (Decreto 572 de 2025): rige todo el año salvo la excepción de mayo–junio. */
export const TABLA_2026: TablaBases = {
  year: 2026,
  valid_from: "2026-01-01",
  valid_to: "2026-12-31",
  uvt: UVT_2026,
  concepts: CONCEPTOS_2026,
  source: FUENTE,
};

/**
 * Excepción: el Consejo de Estado suspendió los artículos 2 a 8 del Decreto 572
 * (auto del 7 de mayo de 2026) y levantó la suspensión (auto del 2 de junio de
 * 2026). Del 8 de mayo al 30 de junio de 2026 rigieron las bases anteriores:
 * 27 UVT compras y 4 UVT servicios. Solo cambian esos conceptos; los demás
 * siguen la tabla general.
 */
export const TABLA_2026_SUSPENSION_572: TablaBases = {
  year: 2026,
  valid_from: "2026-05-08",
  valid_to: "2026-06-30",
  uvt: UVT_2026,
  // El documento solo indica las bases de ese periodo; las tarifas no se registran aquí
  // (la retención siempre usa la tarifa del impuesto configurado en la empresa).
  concepts: [
    b(
      "compras_generales_declarantes",
      "Compras generales (declarantes) — bases anteriores, suspensión Decreto 572",
      27,
    ),
    b(
      "compras_generales_no_declarantes",
      "Compras generales (no declarantes) — bases anteriores, suspensión Decreto 572",
      27,
    ),
    b(
      "servicios_generales_declarantes",
      "Servicios generales (declarantes) — bases anteriores, suspensión Decreto 572",
      4,
    ),
    b(
      "servicios_generales_no_declarantes",
      "Servicios generales (no declarantes) — bases anteriores, suspensión Decreto 572",
      4,
    ),
  ],
  source: `${FUENTE}, nota "Vigencia del Decreto 572 de 2025"`,
};
