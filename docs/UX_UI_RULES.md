# Reglas UX/UI del proyecto

Esta guía es el estándar base para crear, modificar y auditar interfaces del proyecto. Su objetivo es priorizar claridad, jerarquía, usabilidad, consistencia, accesibilidad, escaneabilidad y reducción de fricción antes que la decoración aislada.

## Alcance y precedencia

- Aplicar estas reglas por defecto en todo trabajo de frontend, UX o UI.
- Respetar primero los requisitos funcionales, de marca y las especificaciones explícitas del producto.
- Reutilizar el design system, los tokens, los componentes y las convenciones existentes antes de crear variantes.
- Si una regla entra en conflicto con un requisito superior, conservar el requisito y documentar brevemente la excepción.
- Entre varias soluciones válidas, elegir la que reduzca más la carga cognitiva y la fricción.
- No hacer rediseños puramente estéticos sin un beneficio UX identificable.
- Complementar esta guía con WCAG aplicable, pruebas con usuarios y criterios específicos del producto.

## Formato de auditoría

Clasificar cada elemento revisado como:

- `✅ Correcto`: cumple la regla y no necesita cambios.
- `⚠️ Mejorable`: funciona, pero puede ganar claridad o reducir fricción.
- `❌ Incumplimiento`: existe un problema UX/UI claro.

Cada hallazgo debe indicar el componente o zona, la regla afectada, el motivo y una corrección concreta. Priorizar primero los problemas que bloquean o ralentizan tareas; después, los detalles cosméticos.

## Reglas operativas

### Jerarquía visual y composición

1. **Una acción primaria clara.** En una misma zona debe existir una acción claramente prioritaria; las demás deben tener menor peso visual.
2. **Prioridad visual proporcional.** Tamaño, peso tipográfico, contraste y posición deben reflejar la importancia real. Lo primero que llame la atención debe ayudar a completar la tarea.
3. **Alineaciones consistentes.** Inputs, textos, botones, tarjetas y controles deben compartir ejes, anchos y offsets coherentes.
4. **Espacio que expresa relaciones.** Acercar elementos relacionados y separar grupos distintos; no depender solo de bordes o títulos para comunicar agrupación.
5. **Escala de spacing.** Usar tokens o una escala consistente de gaps y márgenes. Evitar valores arbitrarios.
6. **Contenido escaneable.** Dividir bloques densos mediante títulos, subtítulos, grupos, listas, iconos o separadores cuando aporten claridad.
7. **Texto largo a la izquierda.** Alinear a la izquierda los párrafos de varias líneas; reservar el centrado para textos breves con una razón visual clara.
8. **Resumen controlado.** Usar truncado y “Leer más” solo cuando mejore la escaneabilidad y nunca para ocultar información esencial.

### Color, contraste y apariencia

9. **Bases visuales suaves.** Cuando la marca lo permita, preferir gris casi negro y blanco ligeramente roto frente a negro y blanco puros.
10. **Paleta limitada y coherente.** Todo color funcional debe tener una finalidad semántica o un token definido.
11. **Saturación contenida.** Evitar colores RGB puros o extremadamente saturados salvo necesidad de marca o señalización.
12. **Modo claro controlado.** Puede usar algo más de saturación, manteniendo contraste suficiente y evitando ruido visual.
13. **Modo oscuro descansado.** Reducir saturación o luminosidad de acentos brillantes, especialmente en botones, alertas y estados activos.
14. **Color semántico y redundante.** Éxito, error, advertencia, información y acciones destructivas deben ser consistentes. Nunca transmitir significado solo mediante color: acompañarlo con texto, icono u otro estado perceptible.
15. **Texto sobre imágenes legible.** Garantizar contraste con composición, overlay, degradado u otra técnica y comprobarlo con todas las imágenes reales posibles.

### Tipografía, iconos y legibilidad

16. **Tipografía simple y legible.** Reservar tipografías decorativas para usos puntuales; no utilizarlas en formularios, navegación o bloques informativos.
17. **Iconos familiares.** Usar metáforas reconocibles para inicio, búsqueda, guardar, ajustes, eliminar, volver y otras acciones habituales.
18. **Icono con etiqueta cuando sea ambiguo.** Añadir texto visible o un nombre accesible, especialmente en navegación, toolbars y acciones críticas.
19. **Pantalla escaneable.** El usuario debe poder reconocer rápidamente qué es cada zona, qué puede hacer y dónde continuar.

### Botones, CTAs e interacción

20. **Texto orientado a la acción.** La etiqueta debe describir la consecuencia: “Guardar cambios”, “Enviar solicitud” o “Eliminar”. Evitar “Sí”, “Aceptar” o “Continuar” cuando sean ambiguos.
21. **CTA específico.** Preferir una intención concreta frente a etiquetas genéricas como “Enviar”.
22. **Padding suficiente.** El texto no debe quedar pegado a los bordes y el área visual y táctil debe ser cómoda conforme al sistema.
23. **Affordance reconocible.** Botones, enlaces, tarjetas clicables y controles deben parecer interactivos.
24. **Target mayor que el icono.** En móvil, ampliar la zona pulsable sin necesidad de aumentar el dibujo del icono.
25. **Alcance móvil cómodo.** Situar acciones primarias o frecuentes en zonas accesibles para el pulgar cuando el layout lo permita.

### Formularios y entrada de datos

26. **Label persistente.** No sustituir labels por placeholders; el campo debe seguir identificado después de escribir.
27. **Placeholder auxiliar.** Usarlo como ejemplo, alcance o pista contextual, nunca como etiqueta principal.
28. **Campos mínimos.** Solicitar solo los datos necesarios para la tarea actual; posponer o eliminar los redundantes.
29. **Inputs reconocibles.** Delimitar los campos con claridad para que no parezcan texto estático.
30. **Formato esperado.** Fechas, teléfonos, tarjetas, códigos y otros datos estructurados deben ofrecer máscara o ejemplo, tipo de input, teclado y validación adecuados.
31. **Control adaptado al dato.** No usar siempre un input genérico; por ejemplo, representar un OTP por dígitos si mejora el flujo.
32. **Errores específicos y accionables.** Indicar dónde está el problema, qué ocurrió y cómo corregirlo cuando sea posible.
33. **Radio para elección única.** No usar checkboxes para opciones mutuamente excluyentes.
34. **Checkbox para selección múltiple.** No usar radios cuando puedan elegirse varias opciones.
35. **Pocas opciones visibles.** Mostrar directamente dos o tres opciones claras en lugar de esconderlas en un dropdown.
36. **Búsqueda en listas largas.** Permitir buscar o filtrar países, ciudades, productos, usuarios y catálogos extensos.
37. **Chips con selección evidente.** Usarlos en filtros o selecciones múltiples solo cuando simplifiquen el flujo y su estado sea claro.
38. **Salida “Otro”.** Ofrecer detalle libre cuando una lista no pueda cubrir razonablemente todas las respuestas.
39. **Slider solo para rangos apropiados.** No usarlo cuando el usuario necesite introducir valores exactos con precisión.

### Navegación, procesos y estados

40. **Progreso visible.** En flujos multietapa, mostrar la posición y lo que queda, por ejemplo “Paso 2 de 3” o un stepper comprensible.
41. **Pocos destinos principales.** Mantener aproximadamente entre tres y cinco destinos en tabs o navegación inferior; agrupar destinos secundarios.
42. **Consistencia funcional y visual.** Un componente que hace lo mismo debe verse y comportarse igual en todo el producto.
43. **Lenguaje visual común.** Radios, chips, botones, tarjetas y estados equivalentes deben pertenecer al mismo sistema.
44. **Skeletons con propósito.** Considerarlos para contenido estructurado que tarda en cargar; no usarlos en esperas casi instantáneas ni cuando representen falsamente el contenido.

### Componentes y detalle visual

45. **Radios interiores coherentes.** En elementos anidados, el radio interior debe ser menor que el exterior para mantener el equilibrio visual.
46. **Consistencia antes que decoración.** No introducir una variante visual si un componente existente ya resuelve el mismo caso.

### Principios transversales

47. **Reducir carga cognitiva.** No exigir más opciones, mensajes o decisiones de las necesarias sin eliminar información o capacidades importantes.
48. **Diseñar para datos reales.** Probar contenido dinámico, textos largos, errores, estados vacíos, carga, permisos y diferentes tamaños de dispositivo antes de dar la UI por terminada.
49. **Explicar el razonamiento UX.** Justificar cambios importantes mediante claridad, fricción, jerarquía, accesibilidad o consistencia.
50. **Priorizar el flujo.** Una estética atractiva no compensa una tarea confusa. Resolver primero el recorrido del usuario y pulir después la apariencia.

## Patrones y tokens

- Usar los tokens existentes para color, tipografía, spacing, radios, sombras, breakpoints y estados.
- Esta guía no define hexadecimales, fuentes, tamaños, breakpoints, escala de spacing, radios ni un tamaño numérico de target táctil. No inventar valores atribuyéndolos a ella.
- Mantener una jerarquía de variantes clara: acción primaria dominante, acciones secundarias de menor énfasis y acción destructiva semánticamente diferenciada.
- Mantener el patrón `label persistente + placeholder auxiliar + ayuda/error contextual` en formularios.
- Usar `Paso X de Y` o stepper para procesos, skeleton para carga estructurada, icono con texto cuando haya ambigüedad y overlay/degradado para texto sobre imágenes.
- Diseñar explícitamente los estados normal, hover, focus, active, disabled, loading, error, empty, success y restricted cuando sean aplicables.

## Checklist antes de terminar una pantalla

- [ ] Existe una acción primaria claramente reconocible.
- [ ] La jerarquía visual conduce la mirada hacia lo importante.
- [ ] Alineaciones, espacios y tamaños siguen un sistema consistente.
- [ ] Los textos largos son legibles y fáciles de escanear.
- [ ] Los colores tienen una función y mantienen contraste suficiente.
- [ ] Los elementos interactivos parecen interactivos.
- [ ] Los targets táctiles son cómodos en móvil.
- [ ] Los botones explican claramente qué harán.
- [ ] Los formularios solicitan solo información necesaria.
- [ ] Todos los campos conservan un label comprensible.
- [ ] Error, carga, vacío y éxito tienen estados diseñados.
- [ ] Los controles corresponden al tipo de dato y selección.
- [ ] Las listas grandes permiten buscar o filtrar cuando procede.
- [ ] La navegación evita demasiados destinos al mismo nivel.
- [ ] Los componentes reutilizan el design system existente.
- [ ] La pantalla funciona con contenido real, textos largos y casos límite.
- [ ] La propuesta reduce fricción en vez de añadir decoración gratuita.
- [ ] Los cambios importantes pueden justificarse desde UX.

## Excepciones

Cuando una excepción sea necesaria, registrar junto al cambio:

- La regla que no se aplica.
- El requisito funcional, de marca o del sistema que prevalece.
- El impacto UX conocido.
- La mitigación adoptada, si existe.

Esta guía consolida y adapta consejos públicos de Wadhah Aloui (`@wadhah_the_uxer`). Es una referencia operativa, no una transcripción literal ni un sustituto de requisitos de accesibilidad, investigación con usuarios o criterios propios del producto.
