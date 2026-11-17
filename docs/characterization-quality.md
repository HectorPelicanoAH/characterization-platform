# Calidad de caracterización y refinado

Revisión realizada el 16 de noviembre de 2026.

## Referencias en skills.sh

Las referencias más cercanas al recorrido funcional y la identificación de escenarios son:

| Skill | Aplicación a Characterize |
| --- | --- |
| [bdd-gherkin-testing](https://www.skills.sh/mejbaurbahar/software-tester-skills/bdd-gherkin-testing) | Separar reglas, ejemplos y preguntas; describir intenciones de negocio y evitar instrucciones de interfaz en Gherkin. |
| [exploratory-testing](https://www.skills.sh/mejbaurbahar/software-tester-skills/exploratory-testing) | Recorridos con objetivo, tiempo limitado y notas sobre resultados, preguntas y caminos pendientes. |
| [test-design-techniques](https://www.skills.sh/mejbaurbahar/software-tester-skills/test-design-techniques) | Elegir clases equivalentes, límites, transiciones de estado y tablas de decisión según la regla. |
| [bdd](https://www.skills.sh/nivoset/skills/bdd) | Mantener el vocabulario comprensible para una persona de negocio y los resultados observables. |

Se han incorporado criterios a las instrucciones de generación y refinado; no se han instalado paquetes de skills de terceros. La [referencia oficial de Gherkin](https://cucumber.io/docs/gherkin/reference/) define `Scenario Outline`, los parámetros entre `< >` y las tablas `Examples`.

## Hallazgos del proceso

La ejecución exhaustiva local revisada registró 241 llamadas frente al máximo de 280. Duró aproximadamente doce minutos y falló con `Unexpected token 'S', "Start with"... is not valid JSON`: la salida de Copilot contenía texto antes del objeto esperado. Este fallo explica que esa ejecución no terminase correctamente; no demuestra por sí solo por qué el proveedor decidió finalizar su recorrido antes del máximo.

El máximo se aplicaba en el puente del navegador, pero la finalización dependía del criterio del modelo. Tampoco se exigía revisar los controles pendientes antes de redactar el informe. La interfaz mostraba solo llamadas exitosas frente a un límite que también incluía snapshots e intentos fallidos.

Ahora el puente devuelve el presupuesto restante, ofrece `finish_exploration` y guarda el estado del recorrido. Rechaza declarar presupuesto agotado prematuramente y exige justificar por pantalla los controles pendientes si el cierre es anticipado. El informe incorpora los pendientes y bloqueos medidos aunque el modelo omita esa revisión. La interfaz cuenta todas las llamadas consumidas. El lector valida el objeto contra el esquema incluso cuando está rodeado de prosa o de un bloque Markdown, y conserva la salida del proveedor para diagnóstico.

El protocolo de cierre guía y comprueba las llamadas que haga el agente. Un proveedor todavía puede terminar o fallar sin invocarlo; en ese caso se registra expresamente la revisión incompleta. Llegar a 280 llamadas tampoco acredita cobertura completa.

## Redacción y parámetros

Una ejecución posterior completó 280/280 llamadas, guardó 62 reglas y registró `finish_exploration`. Falló 180 segundos después del cierre al aplicarse el mismo límite de inactividad a la elaboración del informe. Copilot tenía `--stream off`, por lo que ese silencio no permitía distinguir una generación larga de un bloqueo real. Ahora usa streaming; la preparación del informe se identifica a partir del cierre guardado, del máximo de llamadas o del tiempo de exploración. Esta fase dispone de diez minutos adicionales con un límite absoluto que no se renueva con cada salida. Las observaciones de navegador siguen sujetas al presupuesto original. La salida se conserva durante la ejecución, también si termina por timeout.

Las reglas incrementales y el informe final reciben la misma guía de redacción: inglés en todas las cláusulas, una regla por escenario, intenciones de negocio y valores incidentales en la evidencia. Los datos que condicionan una regla pueden expresarse mediante `parameters.columns` y `parameters.rows`, que se renderizan como `Scenario Outline` con `Examples`. Se valida que cada parámetro tenga una columna única y que todas las filas estén completas. Las filas deben proceder de observaciones; una sola muestra no acredita todos los valores posibles.

El ejemplo de la bolsa puede reducirse a:

```gherkin
Scenario: Remove the last bag line
  Given the bag contains one line
  When the user removes that line
  Then the bag is empty
```

Los enlaces de acceso a cuenta y las recomendaciones se documentan por separado cuando representen reglas observadas relevantes. No hace falta parametrizar una frase de interfaz que no define el comportamiento.

## Refinado con IA

Desde **Refine with AI**, el usuario comenta un escenario. La IA recibe el escenario, evidencia acotada y contexto de otros escenarios del mismo origen. Si el conjunto supera el límite de contexto, se explicita que la evaluación de impacto es parcial. Se utiliza la cuenta y configuración de modelo de la exploración original, en un proceso sin herramientas de navegador ni comandos disponibles para el modelo.

El resultado puede pedir aclaraciones o presentar sustituciones. Los escenarios relacionados quedan desmarcados de inicio. El usuario revisa las propuestas y confirma cuáles guardar; las observaciones agrupadas muestran su alcance. Antes del guardado se comprueba que todos los escenarios siguen vigentes. Una única escritura atómica registra las sustituciones elegidas y mantiene estables los identificadores, las exclusiones y la evidencia.

Los cambios se reflejan en la biblioteca y sus descargas Gherkin. El informe original y los tests Playwright generados se conservan; la interfaz identifica los escenarios refinados como pendientes de revisión de tests. El refinado no ejecuta nuevas comprobaciones sobre la aplicación ni acredita reglas que no se hayan observado. Las propuestas no guardadas caducan al reiniciar el servidor o al limpiar previews antiguos.

## Validación

Las pruebas cubren la salida de Copilot con prefacio, los parámetros y las tablas, las aclaraciones, la selección explícita de escenarios relacionados, las observaciones agrupadas, la persistencia, las propuestas obsoletas y los gaps de un cierre anticipado. Las pruebas de interfaz usan respuestas de IA simuladas; no consumen una suscripción. El puente Playwright se comprueba contra un servidor de prueba real.
