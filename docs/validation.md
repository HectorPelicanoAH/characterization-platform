# Validación

Se mantienen separados los resultados de pruebas deterministas, navegador/MCP real y proveedor IA real. Las cuentas de Claude y Copilot no se conectan en nombre del usuario.

## Pruebas automatizadas

- `npm test`: dominios y subdominios, aislamiento entre hosts privados, URL válida, contexto acotado/exclusiones, construcción de argumentos, parseo estructurado, referencias de evidencia, persistencia, reinicio y terminación de procesos reales.
- `npm run test:e2e`: configuración y persistencia en navegador, requisito de una cuenta, selección de cobertura, móvil sin desbordamiento, restricciones API; puente real con MCP oficial y Chromium para redirecciones internas/externas.
- `npm run typecheck` y `npm run build`: validación TypeScript y compilación de producción.

El test de interfaz simula el estado de cuentas para no usar una cuenta real. El test del puente no simula Playwright ni la navegación. Ninguno de ellos, por sí solo, demuestra la calidad de inferencia de un proveedor.
