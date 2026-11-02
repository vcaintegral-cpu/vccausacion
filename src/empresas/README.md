# Empresas: núcleo global y perfiles

```
src/empresas/
├── tipos.ts          Tipos: módulos del menú, funciones, perfil
├── global.ts         NÚCLEO GLOBAL: valores por defecto para todas las empresas
├── registro.ts       Registro central: perfilDeEmpresa(), moduloActivo(), funcionActiva()
├── registro.test.ts  Valida NIT, DV, duplicados y claves
├── use-perfil.ts     usePerfilActivo() para las pantallas
├── led-lights/       Perfil específico LED LIGHTS S.A.S. (900.470.166-4)
├── ballet/           Perfil específico BALLET FOLCLÓRICO (800.212.838-7)
└── _plantilla/       Reservada para empresas nuevas (no se registra)
```

## Cambio para TODAS las empresas

Se hace en el núcleo (`src/lib`, `src/routes`, `src/components`) sin preguntar
por empresa. Aplica también a las empresas que se creen en el futuro.

## Cambio para UNA o ALGUNAS empresas

1. Definir la función en `global.ts` → `FUNCIONES`, con `porDefecto: false`
   (o `true` si casi todas la llevan) y la fecha en `agregada`.
2. Encenderla (o apagarla) en el perfil de cada empresa afectada:
   `funciones: { mi_funcion: true }`. Si la empresa no tiene perfil, crearlo
   desde `_plantilla/` y agregarlo a `PERFILES` en `registro.ts`.
3. En el código del núcleo, envolver el comportamiento nuevo:
   - pantallas: `const { funcion } = usePerfilActivo(); if (funcion("mi_funcion")) …`
   - servidor o lógica: `funcionActiva(nitDeLaEmpresa, "mi_funcion")`
4. El comportamiento anterior queda intacto para las demás empresas.

Para ocultar una pantalla del menú a una empresa: `modulos: { documentos_soporte: false }`
en su perfil. Administración y Empresas no se pueden ocultar.

## Datos de cada empresa

PUC, terceros, reglas por proveedor, IVA, retenciones, centros de costo, Siigo,
facturas y aprendizaje viven en la base de datos, aislados por empresa
(`company_id`). No se copian a los perfiles.
