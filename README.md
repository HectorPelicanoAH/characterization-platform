# Characterize

Una aplicación local para convertir el comportamiento observado de una web en tests de caracterización con un agente de IA y el **MCP oficial de Playwright**.

## Arrancar

Requisitos: Node.js ≥22.18, npm y macOS o Linux con un navegador Chromium. La primera instalación necesita Internet.

```sh
npm install
npm run setup:browser
npm run dev
```

Abre **http://127.0.0.1:4320**. Para servir la versión compilada:

```sh
npm run build
npm start
```

El puerto se cambia con `PORT`. Los datos se guardan en `.data/` (ignorado por Git); `CHARACTERIZE_DATA_DIR` permite elegir otro directorio. La aplicación escucha exclusivamente en loopback.

## Cómo funciona

1. **Configuración:** conecta al menos una cuenta Codex, Claude o Copilot. El botón ejecuta el login de la CLI oficial, que abre el navegador. Puedes reutilizar una sesión Codex o Claude existente. Las CLI están incluidas como dependencias. Solo necesitas una cuenta, con acceso al proveedor correspondiente.
2. Añade opcionalmente instrucciones y rutas absolutas a directorios con skills, instrucciones o guardrails. **Revisar archivos** muestra qué documentos se incluirán. Se leen `.md`, `.mdc`, `.txt`, `.yaml` y `.yml`, con límites y exclusiones; no se ejecutan scripts de skills ni se modifican los directorios.
3. **Caracterización:** indica la URL, un prompt opcional, proveedor, modelo, esfuerzo y cobertura. Codex ofrece sugerencias desde el catálogo real de su CLI; Claude ofrece sus alias. También puedes escribir un ID de modelo de tu cuenta. La compatibilidad del esfuerzo depende del modelo; los errores del proveedor se muestran sin sustituirlo por otro.
4. El agente navega con Playwright en una sesión aislada. La interfaz muestra las acciones observadas, permite detener el proceso y conserva el historial. Con navegador visible puedes completar manualmente el login de la **web objetivo**; todavía no hay pausa/reanudación formal ni almacenamiento de esa sesión.
5. Descarga una suite ZIP con tests TypeScript, configuración de Playwright, informe y evidencias. Revisa el código, instala las dependencias de la suite y ejecuta `npm test` dentro de ella.

**Generado no significa validado.** La plataforma exige referencias a evidencia MCP real y aserciones, pero no ejecuta automáticamente el código generado ni certifica su corrección semántica. Los tests conservan el comportamiento actual, incluso si revela un defecto: no sustituyen la definición de requisitos.

### Navegación y redirecciones

Se permiten todas las rutas, subdominios y cambios de protocolo/puerto del mismo **dominio registrable**, calculado con la Public Suffix List. Por ejemplo, `www.example.co.uk` y `checkout.example.co.uk` pertenecen al mismo alcance; `other.co.uk` no. Los hosts privados como `a.github.io` y `b.github.io` se separan. Para IP y localhost se compara el hostname.

Una redirección observada a un dominio externo se registra como **caso funcional**, con acción de origen, URL de destino y evidencia. El agente debe generar el test correspondiente y volver a la web original. El puente bloquea nuevas interacciones en esa página externa. Esto es una política de exploración, **no un firewall**: cargar una web permite sus recursos y redirecciones, y las restricciones del prompt no garantizan que una acción sea inocua. Usa entornos autorizados y datos de prueba.

### Cobertura

| Nivel      | Objetivo                          | Máximo de acciones MCP | Tiempo máximo |
| ---------- | --------------------------------- | ---------------------: | ------------: |
| Smoke      | Acceso y flujos principales       |                     30 |         8 min |
| Funcional  | Caminos habituales                |                     80 |        20 min |
| En detalle | Variantes y validaciones          |                    160 |        40 min |
| Exhaustiva | Límites y recorridos alternativos |                    280 |        60 min |

Son presupuestos de exploración; **exhaustiva no promete cobertura del 100 %**. El informe enumera lo que no se ha podido recorrer.

## Demo y comprobaciones

```sh
npm run demo
```

La demo está en **http://127.0.0.1:4321**. Incluye catálogo, filtro, carrito sintético, redirección interna y salida a `localhost` como hostname externo de prueba. No realiza compras ni escribe datos.

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Las pruebas de interfaz no consumen IA y simulan únicamente el estado de cuentas. La prueba del puente utiliza un navegador real y el MCP oficial contra un servidor de pruebas.

## Datos e integraciones

Las credenciales permanecen en los almacenes oficiales de las CLI; la plataforma no copia tokens. Copilot no ofrece aquí una consulta independiente de sesión: se guarda que su login terminó correctamente y se comprueba el acceso al ejecutar. Volver a conectar permite renovar una sesión caducada.

Los prompts, contexto y resultados se envían al proveedor elegido. `.data/` contiene contexto, diagnósticos y evidencia de la web que pueden ser sensibles. No se publican desde esta aplicación y no hay borrado automático. Puedes eliminar ejecuciones cerrando la aplicación y borrando sus directorios bajo `.data/runs/`.

Se prioriza una CLI instalada en el PATH; si no existe, se usa la versión fijada en el proyecto. Una versión del sistema incompatible puede fallar: en ese caso utiliza las CLI del proyecto (`PATH="$PWD/node_modules/.bin:$PATH" npm run dev`). No se usan modos de bypass global de permisos. Las CLI y políticas corporativas pueden imponer requisitos adicionales.

[Diseño y alcance](docs/SDD.md) · [Validación](docs/validation.md)

Referencias de integración: [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [Playwright MCP](https://github.com/microsoft/playwright-mcp).

## Diagnóstico y trazas

Abre una ejecución y pulsa **Ver diagnóstico y traza**. La pantalla enlaza cada escenario con evidencia inválida a los eventos fallidos o indica qué ID falta. Las nuevas exploraciones graban acciones, DOM, capturas y red con Playwright en el directorio privado de cada ejecución (`traces/`). El visor se sirve localmente; las trazas pueden contener datos de sesión o de formularios y se eliminan junto con la ejecución. Si no llegó a arrancar Chromium, o si la exploración es anterior a esta función, solo se muestran las evidencias disponibles. Una interrupción brusca puede dejar la última acción incompleta.
