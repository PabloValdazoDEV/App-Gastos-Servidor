# API

Base local: `http://localhost:3000/api`. Este documento enumera únicamente rutas montadas por `src/app.js`; no funciona como backlog de endpoints futuros.

## Convenciones

- JSON UTF-8 con límite de `100kb`.
- Éxito: `{ "success": true, "data": ... }`; los listados pueden añadir `meta`.
- Error: `{ "success": false, "code": "...", "message": "...", "details": ... }`.
- Cookies de sesión con `credentials: include` / Axios `withCredentials`; los JWT no se entregan a JavaScript.
- Todo método mutable requiere la cookie CSRF, el mismo valor en `X-CSRF-Token` y un `Origin` o `Referer` permitido.
- Dinero en céntimos enteros; porcentajes persistidos en puntos básicos (`10000 = 100 %`).
- Fechas civiles en `YYYY-MM-DD`.
- Los recursos de un hogar siempre vuelven a comprobar acceso activo; un UUID válido no demuestra pertenencia.

## Sistema y autenticación

```text
GET    /api/health
GET    /api/legal/privacy-policy
GET    /api/auth/csrf
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
POST   /api/auth/logout-all
GET    /api/auth/me
GET    /api/auth/sessions
DELETE /api/auth/sessions/:sessionId
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
GET    /api/auth/google/start
GET    /api/auth/google/callback
POST   /api/auth/google/link/confirm
```

`GET /api/legal/privacy-policy` es público, usa `Cache-Control: no-store` y devuelve únicamente metadatos públicos:

```json
{
  "success": true,
  "data": {
    "configured": true,
    "version": "2026-08-26",
    "effectiveDate": "2026-08-26",
    "controller": {
      "name": "Nombre del responsable",
      "contactEmail": "privacidad@example.com",
      "address": null,
      "dpoEmail": null
    }
  }
}
```

La aplicación arranca con `configured: false` y valores ausentes como `null`, pero bloquea cualquier alta nueva hasta completar los cuatro metadatos obligatorios. No se exponen secretos.

Obtén primero CSRF mediante `GET /api/auth/csrf`. Registro recibe `{ name, email, password, privacyPolicyAcknowledged: true, privacyPolicyVersion }`. La versión debe ser la publicada por el endpoint legal; el servidor comprueba que siga vigente y persiste su propia versión, nunca una versión confiada al cliente. Si falta la confirmación, devuelve validación accionable; una versión cambiada devuelve `PRIVACY_POLICY_OUTDATED` (409) y una configuración incompleta `PRIVACY_POLICY_NOT_CONFIGURED` (503). Login recibe `{ email, password }`; reset `{ token, password }`. Registro, login, refresh y Google configuran las cookies HttpOnly. Forgot-password responde siempre el mismo texto.

Para una posible alta con Google se usa `GET /api/auth/google/start?privacyPolicyAcknowledged=true&privacyPolicyVersion=<version>`. El backend valida la versión antes de redirigir y firma la confirmación en el estado OAuth. Si el identificador Google ya pertenece a un usuario, puede iniciar sesión sin confirmarla de nuevo. Si el callback fuera a crear un usuario, exige el estado firmado y vuelve a comprobar la versión. Los errores previos al redirect vuelven a `/register?privacyError=<code>`; los detectados en callback vuelven a `/auth/callback?status=error&error=<code>`.

## Hogares, personas, acceso e invitaciones

```text
GET    /api/households
POST   /api/households
GET    /api/households/:householdId
PATCH  /api/households/:householdId
POST   /api/households/:householdId/archive

GET    /api/households/:householdId/people
POST   /api/households/:householdId/people
PATCH  /api/households/:householdId/people/:personId
PUT    /api/households/:householdId/people/distribution
POST   /api/households/:householdId/people/:personId/archive

GET    /api/households/:householdId/access
PATCH  /api/households/:householdId/access/:accessId
DELETE /api/households/:householdId/access/:accessId
POST   /api/households/:householdId/ownership-transfer

GET    /api/households/:householdId/invitations
POST   /api/households/:householdId/invitations
DELETE /api/households/:householdId/invitations/:invitationId
POST   /api/invitations/preview
POST   /api/invitations/accept
```

`POST /api/invitations/preview` es público y recibe el token en el body. Accept exige sesión y CSRF. Archivar conserva históricos; revocar acceso y transferir propiedad aplican invariantes de rol dentro de transacciones.

## Categorías

```text
GET    /api/households/:householdId/categories
POST   /api/households/:householdId/categories
PATCH  /api/households/:householdId/categories/:categoryId
POST   /api/households/:householdId/categories/:categoryId/archive
DELETE /api/households/:householdId/categories/:categoryId
```

DELETE solo tiene éxito cuando las relaciones financieras permiten el borrado. Para categorías con historial se usa archive.

## Gastos recurrentes y pagos

```text
GET    /api/households/:householdId/recurring-expenses
POST   /api/households/:householdId/recurring-expenses
GET    /api/households/:householdId/recurring-expenses/:expenseId
PATCH  /api/households/:householdId/recurring-expenses/:expenseId
DELETE /api/households/:householdId/recurring-expenses/:expenseId
POST   /api/households/:householdId/recurring-expenses/:expenseId/payments
GET    /api/households/:householdId/recurring-expenses/:expenseId/payments
PATCH  /api/households/:householdId/recurring-expenses/:expenseId/payments/:paymentId
```

DELETE de un recurrente es un archivado lógico. Al registrar un pago, `KEEP_PREVIOUS` conserva `amountCents`; `UPDATE_NEXT_AMOUNT` solo es válido para `PAID` y copia el importe real al siguiente importe previsto. El histórico guarda previsto, real, fecha y decisión.

### Registro y corrección desde Calendario (fase 4)

Calendario y Gastos recurrentes utilizan estos mismos endpoints. No se crean pagos para `OneTimeExpense`, facturas ni variables; únicamente para los `RecurringExpense` existentes.

`POST /recurring-expenses/:expenseId/payments` admite `dueDate`, `status=PAID|SKIPPED`, `expectedAmountCents`, `actualAmountCents`, `paymentDate`, `notes`, `nextAmountDecision` y `nextExpectedAmountCents`. Conserva compatibilidad con clientes que omiten `dueDate` (se usa el `nextDueDate` vigente), importe esperado (importe actual del gasto) o fecha de un pago realizado (hoy). La interfaz envía siempre el vencimiento mostrado y la fecha real explícitamente.

- Solo se puede crear un registro para el `nextDueDate` actual de un recurrente activo/no archivado. Se permiten atrasos y pagos anticipados: `dueDate` y `paymentDate` son fechas independientes.
- Registrar `PAID` o `SKIPPED` resuelve una sola ocurrencia y avanza mediante el cálculo de recurrencia existente, incluido `CUSTOM_WEEKS`. No se salta por registros posteriores. `SKIPPED` requiere importe real/fecha nulos y `KEEP_PREVIOUS`; admite notas.
- Una fecha posterior, pasada o arbitraria distinta de la actual devuelve **409 `PAYMENT_NOT_CURRENT_OCCURRENCE`**: «Primero registra el vencimiento pendiente anterior.» La API pública deja de admitir creación histórica arbitraria; los registros existentes se corrigen mediante PATCH. No existe un bypass interno ni una ruta especial para Calendario.
- Un registro ya existente para ese gasto/fecha devuelve **409 `PAYMENT_ALREADY_REGISTERED`**, prioritario incluso después de avanzar o archivar el gasto. La comprobación, autorización, creación, avance y auditoría están dentro de una transacción serializable con reintento de conflictos; se conserva además el constraint único `recurringExpenseId + dueDate` y su traducción a conflicto.
- Los recurrentes inactivos/archivados no admiten nuevas ocurrencias (404 `RECURRING_EXPENSE_NOT_FOUND`). Los permisos de miembro del hogar y el aislamiento personal son los mismos que en Gastos recurrentes.

`PATCH /recurring-expenses/:expenseId/payments/:paymentId` corrige `status`, `actualAmountCents`, `paymentDate` y opcionalmente `notes`. `PAID` exige importe/fecha; `SKIPPED` exige ambos nulos. Omitir notas conserva las anteriores. No admite `dueDate`, importe esperado ni decisiones futuras; nunca escribe el recurrente, mueve `nextDueDate` o reconstruye la recurrencia. Permite corregir históricos de recurrentes archivados si siguen siendo visibles/autorizados.

**Decisión de integridad histórica:** el CHECK existente exige que `UPDATE_NEXT_AMOUNT` corresponda a un registro `PAID` cuyo importe real coincida con `nextExpectedAmountCents`. Si una corrección cambia ese importe o lo convierte a `SKIPPED`, solo la metadata del pago se normaliza a `KEEP_PREVIOUS`/`null`; la decisión e importe anteriores quedan en la auditoría (`previousNextAmountDecision`, `previousNextExpectedAmountCents`, `amountDecisionClearedByHistoricalCorrection`). El importe futuro que se aplicó originalmente **no se revierte ni modifica**. Editar solo fecha/notas conserva una decisión todavía compatible. No requiere migración.

## Facturas

```text
GET    /api/households/:householdId/invoices
POST   /api/households/:householdId/invoices
GET    /api/households/:householdId/invoices/statistics
PATCH  /api/households/:householdId/invoices/:invoiceId
DELETE /api/households/:householdId/invoices/:invoiceId
GET    /api/households/:householdId/invoices/:invoiceId/documents
POST   /api/households/:householdId/invoices/:invoiceId/documents
GET    /api/households/:householdId/invoices/:invoiceId/documents/:documentId/content
DELETE /api/households/:householdId/invoices/:invoiceId/documents/:documentId
```

Las fechas inicial y final del periodo son inclusivas. Statistics calcula equivalentes mensuales ponderados por duración real.

Cada factura admite hasta 5 documentos de 10 MiB como máximo. Upload recibe el archivo como body binario crudo, el nombre como `X-Document-Filename: <encodeURIComponent(filename)>` y uno de estos `Content-Type`: `application/pdf`, `image/jpeg`, `image/png` o `image/webp`. El header evita incluir nombres potencialmente sensibles en URL/logs de proxy; el servidor lo decodifica de forma segura, sanea rutas y controles, y exige que los magic bytes coincidan con el MIME. Tras validar el contenido reemplaza cualquier extensión declarada por la canónica `.pdf`, `.jpg`, `.png` o `.webp`, y trunca el stem de forma segura para persistir como máximo 255 caracteres.

Upload responde 201 y list responde un array con metadatos `{ id, invoiceId, filename, contentType, sizeBytes, uploadedByUserId, uploadedBy: { id, name } | null, createdAt }`. Por minimización, `GET /invoices` solo añade `documentCount`; los metadatos se consultan al abrir una factura. Ninguna respuesta JSON selecciona el contenido `ByteA`.

El endpoint `/content` devuelve bytes, no el envelope JSON, como descarga `attachment`, sin ETag, con `nosniff`, CSP sandbox y caché privada desactivada. Upload y DELETE requieren CSRF; todas las operaciones exigen sesión y acceso activo de miembro al hogar. Errores específicos: `INVOICE_DOCUMENT_CONTENT_TYPE_UNSUPPORTED` (415), `INVOICE_DOCUMENT_SIGNATURE_INVALID` (415), `INVOICE_DOCUMENT_CONTENT_ENCODING_UNSUPPORTED` (415), `INVOICE_DOCUMENT_TOO_LARGE` (413), `INVOICE_DOCUMENT_LIMIT_REACHED` (409), `INVOICE_DOCUMENT_EMPTY` (400), `INVOICE_DOCUMENT_FILENAME_INVALID` (400), `INVOICE_DOCUMENT_UPLOAD_INVALID` (400) e `INVOICE_DOCUMENT_NOT_FOUND` (404).

La validación de firma también exige terminadores/longitudes básicos de cada contenedor, pero no sustituye antivirus, CDR ni análisis de malware. Antes de producción debe evaluarse escaneo asíncrono, cuarentena y almacenamiento de objetos privado si el volumen o el riesgo lo justifican.

## Periodicidades reales por semanas (fase 3)

Las rutas existentes de recurrentes (`POST /api/households/:householdId/recurring-expenses` y `PATCH /api/households/:householdId/recurring-expenses/:expenseId`) admiten:

```json
{ "frequency": "CUSTOM_WEEKS", "intervalWeeks": 4 }
```

`intervalWeeks` debe ser un entero entre 2 y 520; una semana se representa únicamente mediante `WEEKLY`. En creación hay que enviar el resto de los campos requeridos del gasto. Listados, detalle y respuestas de creación/edición incluyen el nuevo campo nullable. No cambia el default Mensual del formulario ni los contratos de `WEEKLY`, `MONTHLY` o `CUSTOM_MONTHS`.

El servidor valida y normaliza ambos intervalos. Solo `CUSTOM_WEEKS` conserva `intervalWeeks`; solo `CUSTOM_MONTHS` conserva `intervalMonths`. Cambiar de frecuencia limpia el campo incompatible, aunque el cliente omita limpiarlo o reenvíe el valor antiguo. Un PATCH parcial se combina con el gasto persistido antes de validar el intervalo requerido; lectura, normalización y escritura se realizan en transacción serializable. Omitir `remindersEnabled` conserva su valor actual. En frecuencias por semanas se limpia `usualDayOfMonth`, y al volver a meses se toma el día del próximo vencimiento salvo indicación explícita.

Vencimientos y calendario avanzan exactamente `7 × intervalWeeks` días civiles, no meses naturales. El registro de pagos utiliza el mismo cálculo, sin cambiar la semántica de `PAID`, `SKIPPED`, importes reales/previstos ni `UPDATE_NEXT_AMOUNT`; las correcciones de pagos históricos no adelantan el próximo vencimiento. Los recordatorios siguen basándose en `nextDueDate`, sin nueva lógica de frecuencia.

El equivalente mensual usa `amountCents × 52 / (intervalWeeks × 12)` con BigInt y el redondeo monetario existente. Los márgenes se aplican después de mensualizar; no cambia ninguna regla de fase 2. Ejemplo: 40 € cada cuatro semanas → base mensual 43,33 € → 47,66 € con margen del 10 %.

**Decisión sobre reserva:** como ya se excluyen los ciclos semanales/mensuales, `CUSTOM_WEEKS` de 2–4 semanas también se excluye de la reserva teórica. Desde 5 semanas, el ciclo anterior se infiere restando exactamente `7 × intervalWeeks` días a `nextDueDate` (salvo `cycleStartDate` explícito, como antes). Esto no convierte las semanas en meses ni suma la reserva al presupuesto mensual: ambos resultados permanecen separados.

Migración `20260917193000_add_custom_weeks`: añade el enum y `RecurringExpense.intervalWeeks Int?`, con CHECK de coherencia/rango. No convierte ni reescribe gastos existentes; mantiene `intervalMonths` y sus restricciones. Se valida en PostgreSQL real usando fixtures temporales y rollback:

```sh
npm run prisma:migrate:deploy
npm run prisma:generate
CUSTOM_WEEKS_DB_TEST=1 npm test -- tests/customWeeks.integration.test.js
```

La validación Zod es necesaria también para rechazar decimales antes de persistir: Prisma puede convertir un decimal al asignarlo a un campo SQL entero. Las pruebas cubren este caso además de las constraints de la base de datos.

## Gastos variables

```text
GET    /api/households/:householdId/variable-expenses
PUT    /api/households/:householdId/variable-expenses/month
GET    /api/households/:householdId/variable-expenses/statistics
DELETE /api/households/:householdId/variable-expenses/:variableMonthId
```

El PUT recibe `{ categoryId, scope, personalPersonId?, year, month, entryMode, summaryAmountCents?, entries?, notes? }`. `SUMMARY` exige total y prohíbe entries. `DETAIL` prohíbe total resumen y calcula desde entries. Para las medias, la aplicación usa automáticamente solo los meses anteriores al mes de cálculo; el mes en curso todavía no entra en el promedio. El cambio se hace en transacción y las constraints/triggers de PostgreSQL impiden mezclar ambos modos incluso con escrituras concurrentes.

## Presupuesto, saldo, planificación y simulación

### Preferencias de margen (fase 2)

```text
GET /api/households/:householdId/budget-margin-preferences
PUT /api/households/:householdId/budget-margin-preferences
```

GET admite `expenseType=INVOICE|VARIABLE` opcional y devuelve solo preferencias persistidas visibles. Un grupo ausente significa `applySafetyMargin: false`, también para los históricos anteriores a esta fase.

PUT hace upsert del grupo `hogar + tipo + categoría + propietario`:

```json
{
  "expenseType": "INVOICE",
  "categoryId": "uuid-de-categoria",
  "scope": "HOUSEHOLD",
  "personalPersonId": null,
  "applySafetyMargin": true
}
```

Requiere sesión, acceso activo al hogar y CSRF según la configuración del entorno. Las categorías deben pertenecer al hogar y no estar archivadas. Para `PERSONAL` es obligatoria una persona activa del hogar vinculada al usuario autenticado; no se pueden consultar ni configurar grupos personales ajenos. `ownerKey` se calcula en servidor; no se acepta en el body. El cambio se realiza en transacción serializable y genera `AuditLog` de tipo `EXPENSE_CHANGED` / recurso `BudgetMarginPreference`.

La respuesta y las estadísticas de facturas/variables incluyen `applySafetyMargin`, `effectiveMarginBps`, `marginSource` (`CATEGORY|HOUSEHOLD|NONE`), `availableMarginBps` y `availableMarginSource`. Los campos `available*` explican qué margen se usaría al activar el control. La jerarquía sigue siendo categoría → hogar → 0; una categoría con 0 explícito prevalece sobre el hogar.

Las estadísticas separan `historicalAverageCents`, `baseCents`, `averages` y `recommendedCents`; solo este último cambia con el margen. En variables, la base sigue usando la ventana de 3/6/12 meses anterior al mes de cálculo; la media histórica abarca todos los meses ya terminados. Las líneas de presupuesto mantienen `baseCents`, `effectiveMarginBps` y `amountCents`.

`POST /one-time-expenses` acepta `applySafetyMargin` opcional, con default `false`. `PATCH /one-time-expenses/:expenseId` permite cambiarlo; omitirlo conserva el valor guardado. No hay override numérico para puntuales. Los recurrentes conservan exactamente su herencia y override anteriores.

Despliegue: ejecutar `npm run prisma:migrate:deploy` y `npm run prisma:generate` antes de arrancar el servidor actualizado. La migración `20260917190000_add_budget_margin_preferences` es aditiva: no reescribe facturas/meses ni crea preferencias masivas. El índice único usa `ownerKey` no nulo, y un CHECK valida la coherencia con `scope` y `personalPersonId`.

Prueba opcional contra PostgreSQL local: `BUDGET_MARGIN_DB_TEST=1 npm test -- tests/budgetMargins.integration.test.js`. Usa datos ficticios y rollback incluso si falla una aserción; no deja fixtures persistidas.

### Rutas de cálculo y planificación

```text
GET    /api/households/:householdId/budget
GET    /api/households/:householdId/dashboard
PATCH  /api/households/:householdId/balance

GET    /api/households/:householdId/plannings
POST   /api/households/:householdId/plannings/prepare
PATCH  /api/households/:householdId/plannings/:planningId/fund

GET    /api/households/:householdId/simulation

POST   /api/households/:householdId/recovery-plans/preview
POST   /api/households/:householdId/recovery-plans
GET    /api/households/:householdId/recovery-plans
PATCH  /api/households/:householdId/recovery-plans/:recoveryPlanId

GET    /api/households/:householdId/calendar
```

Budget no recibe query y devuelve el presupuesto estándar. Dashboard y Simulation aceptan `date` y `balanceCents` en query; Simulation es GET y no persiste. Dashboard incluye `household.contributionDay` para distinguir el estado previo a la aportación habitual. Balance recibe `{ balanceCents }` y crea snapshot. Plannings admite filtros `year`/`month`; prepare recibe `{ calculationDate, confirmedBalanceCents, confirmedPersonalBalances: [{ personId, balanceCents }] }` y crea el snapshot mensual de forma serializable, normalizando la fecha al día 1. Rechaza un mes ya preparado con `409 MONTH_ALREADY_PREPARED`; no sustituye contribuciones ni confirmaciones anteriores. Calendar acepta `view=MONTH|30_DAYS|90_DAYS|YEAR` y `anchorDate`.

### Previsión del mes financiado con el sueldo anterior

Planificación selecciona por defecto el mes natural siguiente a la fecha efectiva de desarrollo/real. Por ejemplo, el 29 de octubre solicita `dashboard?date=2026-11-01` y prepara noviembre. El selector permanece disponible también en meses preparados y no utiliza el último mes guardado como sustituto de un mes sin preparación. Desde Inicio, los enlaces del mes actual especifican `?mes=YYYY-MM`; preparar el mes siguiente tiene una acción distinta.

Los puntuales y cuotas se seleccionan por el mes de destino. Para las medias variables se utilizan meses anteriores al menor entre la fecha objetivo y la fecha efectiva actual. Excepción: cuando faltan **3 días naturales o menos** para finalizar el mes actual y se consulta un mes posterior, el mes actual registrado también entra en la media como **cierre estimado** (desde el 28 en un mes de 31 días). Se respeta la zona horaria del hogar y la fecha simulada de desarrollo. No se cambia ni se cierra ningún registro, no se prorratean días pendientes ni se inventan meses a cero; nunca se incluyen meses futuros. Las líneas variables implicadas llevan `estimatedClosingMonth: "YYYY-MM"`, también en su copia pública guardada. El margen se aplica una sola vez después de promediar importes base. Las obligaciones recurrentes conocidas siguen incluidas en su propia previsión, sin depender de que se haya registrado su cobro y sin añadirlas otra vez a la media variable.

Los importes del cálculo guardado no se recalculan en lectura. `budgetLines` publica solo los campos del desglose necesarios y únicamente los gastos comunes y personales autorizados por la identidad congelada; nunca publica estadísticas anidadas ni el JSON privado. Un cierre estimado guardado conserva su etiqueta; los cambios posteriores se comunican como diferencias, no como nuevas transferencias automáticas.

`PATCH .../plannings/:planningId/fund` acepta `{ scope: "HOUSEHOLD" | "PERSONAL" | "ALL" }`. `HOUSEHOLD` confirma todas las aportaciones conjuntas, incluido el ajuste; `PERSONAL` confirma solo las aportaciones vinculadas al usuario en la identidad guardada, sin aceptar un identificador de otra persona. `ALL` (también body vacío por compatibilidad) conserva la confirmación conjunta y personal global anterior. Las confirmaciones se guardan con usuario y fecha real en `breakdown.funding`, dentro de una transacción serializable. Son idempotentes y no modifican importes preparados ni saldos bancarios. `FUNDED` se alcanza cuando no queda ningún importe inicial pendiente; no incluye extras posteriores. Los registros antiguos `FUNDED` se consideran ya confirmados sin reescribirlos, pero nunca confirman automáticamente extras.

Cada contribución visible devuelve `funding: { commonConfirmed, personalConfirmed, confirmedCents, pendingCents }` y `canConfirmPersonal`. Los importes confirmados/pendientes se calculan después de aplicar privacidad, sin exponer importes personales ajenos. El frontend distingue previsión guardada, confirmado y pendiente. Confirmar no ejecuta ninguna transferencia ni suma dinero automáticamente al saldo.

Las contribuciones del presupuesto vivo y de la planificación incluyen `personalAmountsHidden`. Si es `true`, el cero de `personalExpenseCents` es un valor redactado por compatibilidad, no un gasto personal de cero: la interfaz muestra «Privado / no disponible» y etiqueta los totales y confirmaciones como conjuntos, no como totales personales completos. La planificación antigua sin identidad verificable también usa esta marca. El total visible del presupuesto reúne los gastos comunes y los personales del usuario, no los personales de todo el hogar.

### Correcciones explícitas de planificación

- Las lecturas incluyen `stateVersion`, `revision`, `canRevise`, `revisionHistory` y `fundingHistory`. La versión aumenta al modificar confirmaciones o añadir una revisión; lecturas y operaciones idempotentes no la cambian. Cada evento nuevo identifica su revisión. Tras la primera revisión es obligatorio enviar `expectedVersion` también para confirmar, evitando que clientes antiguos confirmen importes que no revisaron. El historial respeta las identidades congeladas: los eventos personales y sus motivos solo se muestran a su titular; los motivos de revisión/conjuntos son visibles al hogar.
- `PATCH .../plannings/:planningId/fund` admite además `action: "CONFIRM" | "REVOKE"` (por defecto `CONFIRM`) y `expectedVersion`. Para `REVOKE` son obligatorios versión y `reason` de 3–300 caracteres, y el ámbito debe ser `HOUSEHOLD` o `PERSONAL`, nunca `ALL`. Revocar una marca equivocada no devuelve dinero ni modifica el otro ámbito. Las confirmaciones antiguas se normalizan sin perder la parte no revocada. `fundingEvents` conserva antes/después en el JSON privado y la auditoría registra solo operación, ámbito y versión.
- `GET .../plannings/:planningId/revision-preview` calcula una vista previa sin escribir. Rechaza importes ya confirmados y cambios de identidad respecto a la preparación. Recalcula las aportaciones comunes y los gastos personales del actor; conserva los personales ajenos, los ajustes temporales y los saldos históricos.
- `POST .../plannings/:planningId/revisions` recibe `{ expectedVersion, previewFingerprint, reason }`. Recalcula en transacción serializable y rechaza `409 PLANNING_CHANGED` si cambió la versión o el presupuesto visible revisado. La huella SHA-256 contiene únicamente información visible, nunca importes privados ajenos. Se permite un máximo de 50 revisiones por mes.
- La revisión se añade a `breakdown.revisions`; las filas e importes originales y el presupuesto original no se sobrescriben. Las lecturas y las futuras confirmaciones usan la última revisión. Las marcas de cero euros se conservan como evidencia privada pero se limpian en la nueva revisión para no confirmar automáticamente un importe positivo nuevo. No se modifican cuentas ni snapshots de saldo. Los saldos actuales se corrigen desde Cuentas.

No se permite revisar una previsión con dinero ya confirmado: deshacer una confirmación es exclusivamente para corregir una marca errónea, no para anular una transferencia real. No hay redistribución ni devolución automática de aportaciones realizadas. Estos cambios no necesitan migración de base de datos.

El saldo confirmado sigue siendo una referencia de cobertura: no se descuenta automáticamente del presupuesto ni se asigna por gasto a futuros vencimientos. El reparto de reservas y el colchón por objetivo no forman parte de este cambio. Tampoco se incorporan automáticamente las diferencias posteriores como nuevas aportaciones.

### Aportaciones extra conjuntas

La desviación compara la previsión viva con la guardada; no es una transferencia pendiente ni se reduce al confirmar extras. Un gasto registrado no crea automáticamente un extra. Este flujo es conjunto: no añade ni revela aportaciones personales ajenas.

- `POST .../plannings/:planningId/extras/preview` recibe `{ expectedVersion, amountCents }` y devuelve el reparto exacto en céntimos según los porcentajes de la previsión guardada activa. No escribe datos. El importe debe ser positivo, entero y como máximo 2.147.483.647 céntimos.
- `POST .../plannings/:planningId/extras` recibe además `id` (UUID de operación) y `reason` (3–300 caracteres). Guarda el acuerdo pendiente, separado de las contribuciones originales. Repetir el mismo UUID, actor, importe y motivo no duplica el extra, incluso si avanzó la versión; reutilizarlo con otro contenido produce conflicto. Máximo 100 extras por mes, incluidos los anulados, y suma activa dentro del límite monetario anterior.
- `PATCH .../plannings/:planningId/extras/:extraId` recibe `{ expectedVersion, action, personId?, reason? }`. `CONFIRM` confirma solo la parte de `personId`. `REVOKE` requiere persona y motivo, exclusivamente para marcas erróneas. `CANCEL` requiere motivo y solo se permite sin partes confirmadas; conserva el histórico. Los miembros del hogar pueden registrar una aportación conjunta por cualquiera de las personas del reparto, igual que en la confirmación conjunta inicial. No se admite una persona externa al extra.
- Todos estos endpoints requieren acceso al hogar y CSRF. Las escrituras y auditoría son serializables, incrementan `stateVersion` y no cambian cuentas, saldos, presupuesto, filas de contribuciones ni confirmaciones iniciales. Las revisiones se bloquean mientras existan extras no anulados para evitar absorberlos y pedirlos de nuevo.
- `breakdown.extras` guarda importes, reparto congelado, confirmaciones y eventos con fecha real/actor. La respuesta `extras` incluye solo campos comunes públicos; no expone actores ni JSON interno. La previsión y cada contribución incluyen `extraFunding: { agreedCents, confirmedCents, pendingCents }`; cada contribución añade `totalPendingCents` y `totalConfirmedCents`, calculados después de ocultar los datos personales ajenos. Inicio y Planificación muestran «Extras pendientes» aunque la aportación inicial esté `FUNDED`.

No se necesita migración. Acordar, confirmar, corregir o anular extras no hace transferencias ni actualiza los saldos de Cuentas.

Calendar reúne recurrentes y compras por vencimiento, facturas (`INVOICE`) por `chargeDate ?? invoiceDate`, apuntes variables (`VARIABLE_EXPENSE`) por `spentOn` y puntuales (`ONE_TIME_EXPENSE`) por `expenseDate`. Solo expone gastos comunes y personales visibles para el usuario. Facturas y variables llevan `status: RECORDED`, sin implicar un pago confirmado; puntuales llevan `status: UNCONFIRMED`, importe previsto y ningún pago real. Estas fuentes tienen `id` estable y no habilitan registrar/corregir pagos.

Los totales variables (`VARIABLE_SUMMARY`) aparecen una vez por mes solapado con el rango, con el importe completo y `datePrecision: MONTH`, `periodStart`, `periodEnd`, `daysFromToday: null`. Su `dueDate` es el primer día del mes únicamente para ordenar; la interfaz muestra el mes, sin atribuir el gasto a un día ni prorratearlo. En modo detalle solo se incluyen los apuntes, incluso si el mes está incompleto. La interfaz abre `MONTH` por defecto; el valor por defecto del endpoint sigue siendo `30_DAYS`.

### Fecha simulada en desarrollo

Con `NODE_ENV=development`, las peticiones bajo `/api/households` admiten `X-Development-Date: YYYY-MM-DD`. La fecha se valida como fecha civil y se mantiene aislada por petición: cambia el «hoy» de Finance, los rangos/estados del calendario y las fechas de referencia de pagos y garantías de compras. Una fecha explícita de cálculo o de simulación sigue teniendo prioridad. No modifica el reloj de autenticación, las marcas de auditoría ni los jobs de recordatorios. Fuera de desarrollo, enviar esta cabecera devuelve `400 DEVELOPMENT_DATE_DISABLED`; una fecha inválida devuelve `400 INVALID_DEVELOPMENT_DATE`.

El cliente iniciado con Vite en modo `development` muestra «Simular hoy» encima de la pantalla. La selección se guarda en `sessionStorage` por pestaña; aplicar una fecha o volver a la real recarga la página y descarta formularios/cachés anteriores. Los cambios guardados siguen escribiéndose en la base conectada de desarrollo: la fecha simulada no crea una copia de los datos. En producción el control y el envío de la cabecera están deshabilitados.

### Inicio: cuentas y gastos del mes

El dashboard añade `monthlyOverview: { rangeStart, rangeEnd, common, personal }`. Inicio usa este bloque, no la resta entre la recomendación de ahorro mensual y los importes contabilizados de `monthlyProgress`. Los bloques antiguos se conservan por compatibilidad.

Cada ámbito contiene `balanceCents`, `balanceSource`, `expectedCents`, `paidCents`, `unconfirmedCents`, `estimatedCents`, `remainingCents`, `projectedBalanceCents` y `lines` desglosables por tipo. Las identidades personales se filtran igual que en el calendario; `personal` nunca representa a otros miembros del hogar.

- `expectedCents = paidCents + unconfirmedCents + estimatedCents`.
- `remainingCents = unconfirmedCents + estimatedCents`.
- `projectedBalanceCents = balanceCents - remainingCents`: es condicional a que el saldo manual esté actualizado, **no dinero libre ni una transferencia recomendada**. No descuenta pagos confirmados otra vez, reservas futuras, atrasos de otros meses ni la aportación personal a la cuenta conjunta.
- Se suman las ocurrencias del calendario del día 1 al último: pagos recurrentes completos cuando vencen (no sus fracciones de ahorro), facturas por fecha de cargo/factura, variables, puntuales y las participaciones autorizadas en pagos de compras. Los pagos confirmados se atribuyen al mes al que corresponde el gasto aunque se hayan pagado antes/después; no es un extracto de movimientos bancarios por fecha de pago. `SKIPPED` queda excluido. Se conserva el histórico de recurrentes archivados.
- Solo `PAID` / `paidAt` significan pago confirmado. Un importe registrado sin confirmación sigue **por pagar o confirmar**; no se afirma que sea una deuda real.
- Variables en detalle: se añade únicamente lo que falta para la previsión histórica actual, incluido su colchón configurado, sin reducir los gastos si ya la superan. Un resumen mensual sustituye esa previsión. Facturas: cuando no hay ninguna factura de esa categoría/propietario en el mes se conserva una **estimación mensual**, que no fija ni la fecha ni el importe del próximo recibo; al registrarlo, sustituye la estimación. Cada línea estimada expone su base total, importe registrado y colchón para explicar la resta.
- El saldo común procede de las cuentas conjuntas activas, o del saldo guardado del hogar si no hay cuentas. El personal solo procede de cuentas personales activas del usuario. Si falta, el saldo y la proyección son `null`, nunca un cero inventado ni un saldo antiguo de Planificación.
- No cambia saldos, aportaciones guardadas, márgenes configurados ni datos persistidos. Si el reparto no está preparado, se pueden mostrar gastos registrados, pero se advierte que falta la previsión completa.

### Progreso mensual y cobertura de saldos (fase 5, compatibilidad)

`GET /api/households/:householdId/dashboard?date=2026-09-17` añade dos bloques derivados, sin persistir campos nuevos ni modificar las aportaciones preparadas:

```json
{
  "monthlyProgress": {
    "common": {
      "budgetCents": 120000,
      "usedCents": 58000,
      "rawRemainingCents": 62000,
      "remainingCents": 62000,
      "overBudgetCents": 0,
      "progressBps": 4833,
      "status": "WITHIN_BUDGET"
    },
    "personal": null
  },
  "cashCoverage": {
    "common": {
      "balanceCents": 145000,
      "remainingBudgetCents": 62000,
      "cushionCents": 83000,
      "shortfallCents": 0,
      "status": "COVERED",
      "balanceSource": "ACCOUNTS"
    },
    "personal": null
  }
}
```

Cada `personal` es **un objeto**, no un listado: añade `personId` y `personName` de la persona activa vinculada al usuario autenticado. Nunca contiene datos personales de otros miembros, tampoco para OWNER. Si no hay persona vinculada, es `null`. Si existe presupuesto personal pero no hay cuenta personal activa ni saldo personal confirmado en la planificación del mes, solo `cashCoverage.personal` es `null`: no se inventa un saldo conocido de cero. No existe `viewerTotal` ni suma entre dinero de cuentas comunes y personales.

`calculateMonthlySpendingProgress` es un cálculo puro con entradas explícitas. `budgetCents` procede de la recomendación **actual**, incluidos los márgenes efectivos y los puntuales del mes; nunca del snapshot de `MonthlyPlanning`, la aportación proporcional o los ajustes de recuperación. Crear/editar un puntual recalcula ese presupuesto incluso después de preparar el mes. Las aportaciones preparadas conservan su semántica anterior. Si el reparto todavía no permite calcular el presupuesto, `monthlyProgress` y `cashCoverage` completos son `null`, diferenciándolo de un presupuesto configurado de cero.

Reglas de utilizado, aplicadas siempre por ámbito y por mes civil:

| Fuente | Importe real contabilizado | Mes presupuestario |
| --- | --- | --- |
| `ExpensePayment` | `actualAmountCents` solo con `PAID`; `SKIPPED` no suma | `dueDate`, aunque `paymentDate` sea otro mes; incluye padres archivados |
| `VariableExpenseMonth` | suma de entries en `DETAIL`, `summaryAmountCents` en `SUMMARY` | `year` / `month`; no exige que el mes se haya marcado completo |
| `UtilityInvoice` | `amountCents`, íntegro y sin margen | `chargeDate`; solo si es null, `invoiceDate`; no reparte el periodo de consumo |
| `OneTimeExpense` | no se contabiliza como utilizado | su decisión presupuestaria permanece en el presupuesto del mes de `expenseDate` |

La integridad actual exige importe real para `PAID`; no se sustituye silenciosamente por el previsto. Los puntuales no tienen evidencia de pago ni mecanismo de transacción en esta fase. Las medias históricas de facturas/variables y su recomendación no cambian. El ajuste del PUT de variables elimina las entries sustituidas **antes** de pasar de `DETAIL` a `SUMMARY`, dentro de la misma transacción serializable, para respetar el trigger existente.

`rawRemainingCents = budgetCents - usedCents` conserva el signo; `remainingCents` es la parte positiva y `overBudgetCents` la negativa en valor absoluto. `progressBps` no se limita a 10000. Con presupuesto cero y gasto positivo es `null` (porcentaje no definido), manteniendo el gasto y el estado superado; si ambos son cero es 0. Los estados son `WITHIN_BUDGET`, `NEAR_LIMIT` desde el 80 % y `OVER_BUDGET` cuando el utilizado supera el presupuesto; se calcula sin depender del redondeo visual.

Cobertura es un cálculo independiente: `cushionCents = balanceCents - remainingBudgetCents`, `shortfallCents = max(0, -cushionCents)` y estado `COVERED|SHORTFALL`. Un presupuesto superado con saldo positivo puede seguir teniendo cobertura; no significa estar en números rojos. No resta de nuevo todo el presupuesto del mes ni suma aportaciones o reservas teóricas.

Fuentes de saldo para los **nuevos** bloques: suma de las cuentas activas del ámbito (`balanceSource=ACCOUNTS`), o `Household.currentBalanceCents` para común sin cuentas (`HOUSEHOLD`, actualizado tanto al preparar como al registrar saldo manual). El personal sin cuentas utiliza, si existe, su propia confirmación del mes (`MONTHLY_PLANNING`). Un override explícito de consulta usa `OVERRIDE` para común. Las cuentas actuales prevalecen sobre una preparación antigua. Los campos legacy `balanceCents`, `accountSummary` y salud/reserva conservan su lógica anterior para compatibilidad; la nueva UI de cobertura debe usar `cashCoverage`.

Todos son **saldos registrados manualmente**, no saldos bancarios sincronizados. Una fecha histórica en la consulta selecciona los gastos/presupuesto de ese mes, pero no reconstruye el saldo bancario histórico. El colchón tampoco garantiza dinero libre para gastar: no incluye operaciones aún sin registrar y puede faltar actualización de saldos.

La obtención de pagos añade una única consulta acotada: `status=PAID`, `dueDate >= startOfMonth(date)` y `< startOfMonth(date)+1 mes`, con `recurringExpense.householdId` y visibilidad personal en la propia consulta. Selecciona solo importe/fecha/status/scope, aprovecha el índice existente `(dueDate,status)` y no genera consultas por recurrente ni carga todo el histórico de pagos. Reutiliza las facturas/variables que ya necesitaba la recomendación, sin añadir nuevas cargas históricas. Las fechas `@db.Date` siguen las utilidades civiles UTC existentes; no se parsean meses con hora local. Hay regresiones diciembre/enero y pagos tardíos/anticipados.

La sanitización de una planificación elimina también el total recomendado personal ajeno: devuelve presupuesto común + parte personal del visor, además de ocultar breakdown, saldo y líneas personales de terceros. Se conserva el reparto común autorizado; un total agregado tampoco debe permitir inferir cifras privadas por resta.

Pruebas de servicio/consulta: `npm test -- tests/dashboardMonthlyProgress.test.js tests/monthlySpendingProgress.test.js`. Flujo real HTTP + PostgreSQL local, sin dejar datos: `MONTHLY_PROGRESS_DB_TEST=1 npm test -- tests/monthlyProgress.integration.test.js`. Las fixtures se revierten incluso tras errores; cubren registro/corrección/omisión, scopes OWNER/MEMBER, cuentas actualizadas, presupuesto dinámico tras planificación, cambios variables/facturas y cambio de año.

Recovery preview no persiste. En modo `RECOMMENDED` usa el saldo conjunto, la aportación mensual estándar y los meses naturales inclusivos hasta cada vencimiento común. Además de importe y duración devuelve `recommendation`, con la base suave, el mínimo exigido por flujo de caja y el vencimiento limitante. Crear un plan cancela el anterior activo; PATCH admite `COMPLETED` o `CANCELLED`.

Calendar fusiona las ocurrencias futuras activas con `ExpensePayment`: un mismo `expenseId + dueDate` aparece una sola vez y los estados `PAID`/`SKIPPED` históricos siguen visibles después de avanzar `nextDueDate` o archivar el recurrente de pago único. En esos eventos `amountCents` usa el importe real pagado cuando existe y también se devuelven previsto, real y fecha de pago.

Cada evento incluye además `paymentId`, `expectedAmountCents`, `actualAmountCents`, `paymentDate`, `notes`, `canRegisterPayment` y `canEditPayment`. Para un evento programado, `paymentId`, importe real, fecha real y notas son `null`; el importe esperado es el actual del recurrente. `canRegisterPayment=true` únicamente si la fecha es el `nextDueDate` vigente y el recurrente permanece activo/no archivado, sea `OVERDUE`, `DUE` o `UPCOMING`. Las proyecciones posteriores no son registrables. Un evento `PAID`/`SKIPPED` con `paymentId` tiene `canRegisterPayment=false` y `canEditPayment=true`, incluso si su recurrente se archivó. No se devuelve información personal ajena; los flags corresponden a registros visibles para el miembro autorizado.

El frontend debe usar estos permisos calculados, sin solicitar el gasto ni comparar fechas por su cuenta. Los flags son una instantánea, no una autorización permanente: POST/PATCH siempre vuelven a validar la operación. Tras una escritura o conflicto se refrescan las consultas pertinentes; el siguiente vencimiento aparecerá accionable en la nueva respuesta.

## Compras y garantías (fase 6.1)

Dominio independiente en `src/modules/purchases/`. `Purchase` es un registro de bienes, no un movimiento: ninguna operación crea gastos, facturas ni pagos financieros ni modifica cuentas, presupuesto o `monthlyProgress`. Los documentos privados se añaden en la fase 6.2 y el modelo interno de pagos/cuotas en la fase 6.3 descritas más abajo. No hay OCR, IA, garantías legales inferidas ni notificaciones de garantía.

```text
GET    /api/households/:householdId/purchases
POST   /api/households/:householdId/purchases
GET    /api/households/:householdId/purchases/:purchaseId
PATCH  /api/households/:householdId/purchases/:purchaseId
DELETE /api/households/:householdId/purchases/:purchaseId
POST   /api/households/:householdId/purchases/:purchaseId/items
PATCH  /api/households/:householdId/purchases/:purchaseId/items/:itemId
DELETE /api/households/:householdId/purchases/:purchaseId/items/:itemId
```

Todos requieren autenticación y acceso activo al hogar; las escrituras usan la protección CSRF general. Las mutaciones son transacciones `Serializable`, con autorización y visibilidad comprobadas dentro de la transacción y reintentos ante conflictos de serialización. La creación incluye al menos un producto y el AuditLog en la misma transacción. Los cambios de producto escriben también la fila padre: dos eliminaciones simultáneas no pueden dejar una compra sin productos, ni una edición de fecha competir con el cálculo de una garantía.

### Contrato y privacidad

Las respuestas siguen `{ success: true, data }`. GET listado devuelve un array, más reciente primero por `purchaseDate`, luego `createdAt`; búsqueda y filtros del módulo se aplican en cliente sobre este listado autorizado. No incluye archivadas. Cada compra incluye `id`, `householdId`, `merchant`, `purchaseDate` (`YYYY-MM-DD`), `totalCents`, `ownershipType`, `personalPersonId`, `personalPerson: { id, name } | null`, `shares: [{ id, householdPersonId, shareBps, householdPerson: { id, name } }]`, `items`, notas y timestamps. Cada producto añade `warrantyStatus` y `warrantyDaysRemaining`. El listado **omite las propiedades `serialNumber` e `imei`**, presentes solo en detalle y respuestas de escritura autorizadas; no expone `linkedUserId` en personas.

Visibilidad backend, sin excepción para OWNER/ADMIN:

- `HOUSEHOLD`: visible para todos los miembros del hogar.
- `PERSONAL`: solo la persona cuyo `linkedUserId` es el usuario autenticado.
- `SPLIT`: solo si participa una persona vinculada al usuario autenticado.

Una compra invisible, de otro hogar o archivada devuelve el mismo 404 (`PURCHASE_NOT_FOUND`) en detalle y escritura; los productos heredan esa protección. Para conservar la política de asignación de gastos existente, se permite crear/asignar a otras personas activas del hogar. Si la nueva propiedad deja al actor sin visibilidad, POST/PATCH devuelve **únicamente `{ id, accessRevoked: true }`**: el cliente debe volver al listado, no solicitar ni mostrar el detalle. Ser propietario del hogar no otorga acceso extra a compras ajenas.

### Creación y edición

Ejemplo de POST (IDs ilustrativos que deben existir en el hogar):

```json
{
  "merchant": "Apple Store",
  "purchaseDate": "2026-09-17",
  "totalCents": 99900,
  "ownershipType": "PERSONAL",
  "personalPersonId": "00000000-0000-4000-8000-000000000001",
  "items": [{
    "name": "iPhone 17",
    "brand": "Apple",
    "model": "17",
    "quantity": 1,
    "serialNumber": "ABC123",
    "imei": "123456789012345",
    "warrantyDurationMonths": 36
  }]
}
```

POST compra devuelve 201 con la compra creada; PATCH compra devuelve 200 y admite solo metadatos y propiedad, **no `items`**. POST producto devuelve 201 con la compra completa actualizada; PATCH/DELETE producto devuelven 200 con la compra actualizada. Se editan productos mediante sus endpoints independientes. PATCH conserva campos omitidos (incluidas cantidad, propiedad y garantía); `null` permite vaciar los opcionales.

`HOUSEHOLD` normaliza `personalPersonId=null` y elimina shares. `PERSONAL` exige una persona activa del mismo hogar y elimina shares. `SPLIT` normaliza `personalPersonId=null`, exige al menos dos personas activas distintas del hogar y porcentajes enteros positivos que sumen exactamente 10000 bps. Las transiciones se hacen atómicamente y no dejan campos incompatibles. Una edición solo de metadatos conserva referencias históricas a personas archivadas; elegir nuevos titulares exige personas activas.

Límites: `totalCents` y `priceCents` enteros de 0 a 2147483647; `priceCents` puede ser null y no tiene que sumar el total de compra. Entre 1 y 50 productos; cantidad entera 1–10000, por defecto 1; nombre obligatorio hasta 200 caracteres; comercio opcional hasta 200; marca/modelo 120; serial/IMEI 100; notas 2000. Los textos se recortan, opcionales vacíos se normalizan a null y se rechazan caracteres de control no textuales, sin imponer formatos universales de IMEI/serie.

DELETE compra archiva y devuelve `{ id, archivedAt }`, conservando todos los productos y shares. DELETE producto elimina solo ese producto y registra su acción; si es el último, devuelve 409 `PURCHASE_LAST_ITEM`. Los errores de validación son 400 con campos Zod; personas inválidas usan `PURCHASE_PERSON_INVALID`.

### Garantías registradas por el usuario

Cada producto persiste `warrantySource: DURATION | EXPLICIT_DATE | null`, `warrantyDurationMonths` y `warrantyEndsAt` (`@db.Date`, serializado como `YYYY-MM-DD`). La entrada acepta fecha final y/o duración de 1 a 1200 meses. Una fecha explícita **no null tiene prioridad** y guarda `EXPLICIT_DATE`, dejando duración null. `warrantyEndsAt:null` junto con duración selecciona `DURATION`. Ambos null eliminan garantía. Omitir ambos en PATCH conserva el estado existente.

La duración suma meses de calendario a `purchaseDate`, ajustando al último día válido: 31/01/2026 + 1 mes = 28/02/2026; 31/01/2024 + 1 = 29/02/2024. 17/09/2026 + 36 meses = 17/09/2029. Nunca se calcula como 365 días por año. Se rechaza una duración cuyo resultado supere el año 9999 (`WARRANTY_DATE_OUT_OF_RANGE`). Cambiar la fecha de compra recalcula exclusivamente productos `DURATION`; las fechas explícitas permanecen intactas.

El estado no se persiste: se deriva contra el día civil actual de la zona horaria del hogar. `NONE` devuelve días null; `ACTIVE` significa más de 60 días; `EXPIRING_SOON` entre 0 y 60 días inclusivos; `EXPIRED` menos de 0. El propio día final sigue vigente y devuelve 0 días; desde el siguiente devuelve negativos. Umbral centralizado en `WARRANTY_EXPIRING_SOON_DAYS`, no en componentes frontend. No se infieren plazos legales según producto o fecha.

Migración aditiva `20260917210000_add_purchases`: modelos `Purchase`, `PurchaseShare`, `PurchaseItem`, enums `PurchaseOwnershipType`/`PurchaseWarrantySource` y acciones AuditLog `PURCHASE_CREATED`, `PURCHASE_CHANGED`, `PURCHASE_ARCHIVED`, `PURCHASE_ITEM_CREATED`, `PURCHASE_ITEM_CHANGED`, `PURCHASE_ITEM_DELETED`. Índices por hogar/archivo/fecha, persona y producto, unique compra+participante; CHECKs para dinero, cantidades, propiedad y consistencia de garantía; triggers diferidos para pertenencia al hogar, suma y presencia de shares y mínimo un producto. No modifica datos financieros previos.

Pruebas: `npm test -- tests/purchases.test.js`; flujo HTTP + PostgreSQL local `PURCHASES_DB_TEST=1 npm test -- tests/purchases.integration.test.js`. Las fixtures se revierten; los tests fuerzan `SET CONSTRAINTS ALL IMMEDIATE` para comprobar también las restricciones diferidas y prueban rollback ante fallo de auditoría, privacidad incluso OWNER, transiciones, garantía, archivado y ausencia de impacto financiero.

## Documentos privados de compras (fase 6.2)

```text
GET    /api/households/:householdId/purchases/:purchaseId/documents
POST   /api/households/:householdId/purchases/:purchaseId/documents
GET    /api/households/:householdId/purchases/:purchaseId/documents/:documentId/content
PATCH  /api/households/:householdId/purchases/:purchaseId/documents/:documentId
DELETE /api/households/:householdId/purchases/:purchaseId/documents/:documentId
```

Todos requieren autenticación, acceso activo al hogar y visibilidad de la compra. Heredan exactamente la privacidad `HOUSEHOLD`/`PERSONAL`/`SPLIT`, sin excepciones OWNER/ADMIN. No basta conocer el UUID ni haber subido el archivo. La compra de otro hogar, invisible o archivada devuelve 404; un documento de otra compra también devuelve 404. Archivar conserva documentos y binarios, pero sus endpoints dejan de estar accesibles, igual que el resto de la compra. Esta fase no añade recuperación de compras archivadas.

### Contrato de subida y metadatos

POST envía el **archivo binario directamente** (no multipart ni base64), con `Content-Type` y `X-Document-Filename: encodeURIComponent(nombreOriginal)`. Query params:

- `type`: `RECEIPT`, `INVOICE`, `WARRANTY` u `OTHER` (por defecto `OTHER`). UI: Ticket, Factura, Garantía, Otro.
- `purchaseItemId`: UUID opcional; omitirlo asocia a la compra completa. Si se indica, debe pertenecer a esa misma compra.

Responde 201 con metadatos. GET listado devuelve un array ordenado por creación descendente. Cada documento expone `id`, `purchaseId`, `purchaseItemId` nullable, `uploadedByUserId`, `uploadedBy: { id, name }`, `type`, `filename`, `contentType`, `sizeBytes`, `createdAt`, `updatedAt`. Nunca se incluye contenido, base64, rutas internas, URLs públicas ni claves de almacenamiento. No se añade `documentCount` al JSON de Purchase.

PATCH admite exclusivamente `{ type?, purchaseItemId?: UUID | null }`, con al menos un campo. `null` lo devuelve a la compra completa. No permite cambiar filename, tamaño, usuario, compra ni binario. POST/PATCH verifican de nuevo pertenencia y permisos dentro de una transacción Serializable; las mutaciones escriben también el padre para serializarse con archivo, cambios de propiedad o borrado de producto. **Eliminar un producto conserva sus documentos, asociados desde entonces a la compra completa** (`ON DELETE SET NULL`).

### Formatos y entrega privada

Se permiten exclusivamente PDF, JPEG, PNG y WebP, con máximo **10 MiB** centralizado en `MAX_PRIVATE_DOCUMENT_SIZE_BYTES`; el módulo publica el alias `MAX_PURCHASE_DOCUMENT_SIZE_BYTES`. Exceso: 413 `PURCHASE_DOCUMENT_TOO_LARGE`, mensaje «El archivo supera el tamaño máximo permitido.». Se rechazan vacíos (400), MIME no permitido (415), firma/estructura incompatible con MIME (415), transporte comprimido (415), query/body desconocidos (400) y producto de otra compra (400). Autenticación, CSRF, permisos, MIME, nombre y tamaño declarado se validan antes de leer el raw body; el parser limita también streams sin longitud declarada.

Se reutiliza la validación de firmas y estructura básica de `InvoiceDocument`, extraída sin cambiar su contrato a `src/services/privateDocumentFiles.js`. No se añade parser nuevo, análisis del contenido ni antivirus. Los nombres conservan el texto original saneado: se quitan paths Unix/Windows, controles y caracteres de formato, se limita a 255 caracteres y se normaliza la extensión al tipo validado. El nombre nunca se interpreta como una ruta de servidor.

GET contenido permite `?disposition=inline` para visualizar; por defecto usa `attachment` para descargar. Devuelve bytes con `Content-Type` validado, `Content-Length`, `Content-Disposition` con fallback ASCII y `filename*` RFC 5987, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` y `Content-Security-Policy: sandbox; default-src 'none'`. No genera ETag del binario ni URLs permanentes de `/uploads`. Listados y respuestas de mutación también llevan `private, no-store`. Si el binario falta o no coincide con el tamaño, la lectura falla con 503 y no finge éxito.

### Almacenamiento, integridad y auditoría

Migración aditiva `20260917223000_add_purchase_documents`: `PurchaseDocument`, enum `PurchaseDocumentType` y tabla privada `PurchaseDocumentContent` con `documentId` único y `content Bytes`. No cambia compras existentes. El adapter `postgresPurchaseDocumentStorage` (`src/modules/purchases/documentStorage.js`) ofrece `save(database, { documentId, content })`, `get(database, { documentId })` y `delete(database, { documentId })`; el dominio no conoce cómo se almacena el binario. Se puede inyectar mediante `createPurchasesRouter({ ..., documentStorage })`.

Se utiliza PostgreSQL privado, igual que InvoiceDocument, sin añadir S3 ni servicios externos. Metadata, bytes y auditoría se crean/borran en la misma transacción. Fallos de save/delete/auditoría revierten todo; DELETE solo responde `{ id, deleted: true }` tras completarse. FK impide contenido huérfano y triggers SQL diferidos exigen que exista el binario con el tamaño declarado y que un producto pertenezca a la misma compra, incluso ante SQL directo. Migrar a object storage requiere sustituir el adapter y migración de su tabla/constraints, con staging/compensación equivalente para mantener atomicidad y reintentos; no requiere reescribir autorización, rutas o lógica de metadatos.

AuditLog registra `PURCHASE_DOCUMENT_ADDED`, `PURCHASE_DOCUMENT_CHANGED` y `PURCHASE_DOCUMENT_DELETED`, con actor, hogar e IDs de compra/documento. No guarda nombre de archivo, contenido ni binarios. Ninguna operación crea Invoice, gastos, pagos, cuotas ni altera presupuesto, planificación, saldos o garantías. No hay OCR, IA, extracción de datos, OpenAI, financiación ni Telegram.

Pruebas unitarias/router: `npm test -- tests/purchaseDocuments.test.js`. Integración HTTP + PostgreSQL con fixtures reversibles y restricciones forzadas: `PURCHASE_DOCUMENTS_DB_TEST=1 npm test -- tests/purchaseDocuments.integration.test.js`.

## Formas de pago y financiación de compras (fase 6.3)

El bien (`Purchase.totalCents`: precio de compra) está separado de cómo se paga. El modelo de esta fase es exclusivamente un registro privado de pagos y calendario propio de la compra: **no modifica BudgetPage, Dashboard, monthlyProgress, Calendar global, saldos, OneTimeExpense, RecurringExpense ni ExpensePayment**. No hay integración financiera automática, IA/OCR, Telegram ni refinanciación automática.

### Contado, entrada y financiación

POST/PATCH de Purchase admiten `paymentMethod: UPFRONT | FINANCED` (UI: Al contado / Financiado). La migración aditiva `20260917230000_add_purchase_payments` asigna `UPFRONT` por defecto a compras anteriores, **con `paymentDate=null` y `paidAmountCents=null`**: no inventa pagos históricos ni cuotas. Una nueva compra sin información explícita de pago también queda sin confirmar; seleccionar el método no prueba que se haya pagado.

Para confirmar contado se envían ambos campos, por ejemplo:

```json
{
  "paymentMethod": "UPFRONT",
  "paymentDate": "2026-09-17",
  "paidAmountCents": 99900
}
```

Fecha e importe deben estar ambos presentes o ambos null. Se permite importe cero para una compra gratuita y corregir fecha/importe, pero nunca inferirlos desde el precio. No se crea una financiación ficticia de una cuota. Las fechas de pagos reales (contado, entrada, cuotas) no pueden ser posteriores al día civil actual del hogar. Un pago sí puede ser anticipado respecto al vencimiento previsto.

Para una compra de 120000 céntimos financiada:

```json
{
  "paymentMethod": "FINANCED",
  "financing": {
    "provider": "Entidad o tienda",
    "downPaymentCents": 20000,
    "downPaymentPaidAt": null,
    "installmentCount": 20,
    "installmentAmountCents": 5500,
    "firstInstallmentDate": "2026-10-15",
    "financingTotalCents": 110000
  }
}
```

`financedPrincipalCents` se deriva únicamente en backend: precio menos entrada (100000). No se acepta como dato controlado por cliente. `financingTotalCents` es la suma contractual de cuotas, no incluye entrada. Coste total esperado: entrada + total de cuotas (130000); coste de financiación: coste total menos precio (10000). Entrada no negativa ni superior al precio, cuota habitual y total positivos, total de cuotas no inferior al principal. Campos monetarios limitados a 2147483647 céntimos; sumas derivadas pueden superar ese entero, pero deben ser enteros seguros JavaScript.

La entrada **no es una cuota** y no aumenta el contador de cuotas pagadas. `downPaymentPaidAt` es null hasta confirmación explícita; indicar una fecha válida confirma que se pagó el importe de entrada. Una entrada de cero no admite fecha de pago. Omitir la fecha no confirma un pago histórico.

### Calendario exacto y edición protegida

`PurchaseFinancing` es único por compra. Contiene proveedor opcional hasta 200 caracteres, entrada/fecha de pago, principal derivado, número e importe habitual de cuotas, primera fecha y total contractual. Genera de 1 a 1200 `PurchaseInstallment`, con `sequence` 1..N, `dueDate`, `expectedAmountCents`, importe/fecha real nullable, `status: PLANNED | PAID | CANCELLED`, notas opcionales hasta 2000 caracteres y timestamps.

Fechas mediante `addCalendarMonths` ancladas siempre a la primera: 31/01 → 28/02 → 31/03, respetando años bisiestos y diciembre→enero; no son periodos de 30 días. Primera fecha y última deben caber en el año 9999. Las primeras N−1 cuotas usan el importe habitual y la última el resto exacto; 10000/3 con habitual 3333 genera 3333, 3333, 3334. La última puede diferir de la habitual, pero debe ser positiva y caber en el rango monetario. La multiplicación/resta usa BigInt para no perder céntimos ni desbordar.

PATCH Purchase admite `financing` parcial para editar proveedor o corregir fecha de entrada. Si no hay cuotas PAID, los cambios estructurales regeneran el calendario y permiten cambiar UPFRONT ↔ FINANCED. Si se retira un pago de contado/entrada ya confirmado, o se altera su importe, se exige `confirmPaymentReset: true`. Su valor y fecha anteriores quedan en auditoría. Cambiar importe de una entrada confirmada sin enviar nueva fecha explícita la deja sin confirmar; no se arrastra una evidencia antigua a un nuevo importe.

Con alguna cuota PAID se bloquean los cambios destructivos de método, precio, entrada, principal, número, importe habitual, primera fecha y total de cuotas, incluso con confirmación: 409 `PURCHASE_FINANCING_PAID_INSTALLMENTS`, «Ya existen cuotas registradas como pagadas.». No se deben retirar pagos legítimos para eludir esta protección. Sí se permite proveedor, fecha/corrección explícita de entrada y demás metadatos no estructurales. Reenviar exactamente la misma configuración conserva IDs de financiación/cuotas y pagos. Archivar una compra conserva todo el modelo de pago, sujeto a la misma inaccesibilidad de la compra archivada.

### Registro y corrección de cuotas

```text
POST   /api/households/:householdId/purchases/:purchaseId/installments/:installmentId/pay
PATCH  /api/households/:householdId/purchases/:purchaseId/installments/:installmentId/payment
DELETE /api/households/:householdId/purchases/:purchaseId/installments/:installmentId/payment
```

POST registra solo una cuota PLANNED; PATCH corrige solo una PAID. Ambos aceptan `{ actualAmountCents, paidAt: "YYYY-MM-DD", notes?: string | null }`. Importe real positivo, no necesariamente igual al esperado; omitir notas al corregir las conserva. POST duplicado devuelve 409 y nunca duplica pagos. DELETE exige body `{ "confirm": true }`, cambia PAID → PLANNED y limpia importe/fecha/notas del registro actual; audit conserva antes/después. No existe operación para «omitir» cuotas, ni para pasar una cuota a CANCELLED desde esta UI/API. Ese estado queda reservado para anulaciones/refinanciación futuras.

Los tres endpoints devuelven 200 con la Purchase completa actualizada. Autenticación y CSRF según política general; hogar y compra visibles, sin excepción OWNER/ADMIN; cuota de otra compra/otro hogar/invisible/archivada devuelve 404. Cada mutación usa transacción Serializable, reautoriza dentro, escribe el padre para impedir carreras con cambios de método/estructura/propiedad/archivo y se audita atómicamente. Un fallo de auditoría revierte el pago.

### Detalle y progreso

Todas las respuestas Purchase añaden `paymentMethod`, `paymentDate`, `paidAmountCents` y `financing` nullable. En detalle, financiación incluye `installments` ordenadas por secuencia, con fechas civiles `YYYY-MM-DD`, y `progress`:

```text
paidCents                 = importes reales de cuotas PAID + entrada confirmada
pendingCents              = importes previstos PLANNED + entrada sin confirmar
downPaymentPendingCents   = entrada no confirmada (o 0)
paidInstallmentCount      = número de cuotas PAID, sin incluir entrada
installmentCount          = número contractual de cuotas
nextInstallment           = { id, sequence, dueDate, expectedAmountCents } o null
costOfFinancingCents      = entrada + total contractual de cuotas − precio
totalCostCents            = entrada + total contractual de cuotas
```

La próxima cuota es la PLANNED más temprana, incluso si está vencida. No se considera pagada por haber pasado su fecha. Las CANCELLED no suman pagado ni pendiente. Un sobrepago de una cuota no liquida automáticamente otra: `pendingCents` no es coste contractual menos pagos reales; mantiene las obligaciones restantes registradas. Listado Purchase devuelve resumen de financiación/progreso, **sin la lista completa de cuotas**. Internamente selecciona solo los seis campos de cuota necesarios para el agregado (no notas ni fechas reales); se conserva el listado sin paginar de Compras existente. Grandes volúmenes pueden requerir paginación/agregación SQL en una optimización posterior, sin modificar cálculos financieros externos.

Auditoría añade `PURCHASE_PAYMENT_METHOD_CHANGED`, `PURCHASE_PAYMENT_CHANGED`, `PURCHASE_FINANCING_CREATED`, `PURCHASE_FINANCING_CHANGED`, `PURCHASE_INSTALLMENT_PAID`, `PURCHASE_INSTALLMENT_CORRECTED`. Guarda IDs y snapshots antes/después de configuración y pago corregidos, sin tocar la lógica de documentos. Restricciones SQL diferidas aseguran consistencia método/financiación, principal, número, fechas ancladas y suma exacta de cuotas; CHECKs aseguran estados e importes/fechas de pago compatibles.

Pruebas: `npm test -- tests/purchasePayments.test.js`; integración con rollback y restricciones reales: `PURCHASE_PAYMENTS_DB_TEST=1 npm test -- tests/purchasePayments.integration.test.js`.

## Historial de reparto de compras y orden de cuotas (fase 6.4)

La fase 6.4 conecta el plan de pago al presupuesto estándar sin crear OneTimeExpense, RecurringExpense, UtilityInvoice ni movimientos de saldo bancario. Las descripciones de aislamiento financiero de 6.1–6.3 corresponden al comportamiento anterior: ahora se consumen fuentes de compra nativas. No se analiza ningún documento.

### Reparto histórico explícito

Migración `20260917233000_purchase_financial_allocations` añade tres JSON privados: `Purchase.paymentAllocationSnapshot`, `PurchaseFinancing.downPaymentAllocationSnapshot` y `PurchaseInstallment.paymentAllocationSnapshot`. Solo existen para un contado confirmado, una entrada confirmada o una cuota PAID, respectivamente; se guardan dentro de la misma transacción que el pago y la auditoría.

Formato interno v1 (no se devuelve en la API): `{ version: 1, householdId, ownershipType, allocations: [{ scope, personalPersonId, linkedUserId, shareBps }] }`. Común es una asignación HOUSEHOLD de 10000 bps; PERSONAL es una asignación personal de 10000; SPLIT son asignaciones **personales**, no gasto común. Se captura también el usuario vinculado en ese momento para que cambiar la vinculación de una persona no transfiera silenciosamente su historia financiera.

`createPurchaseAllocationSnapshot` y `allocatePurchaseAmount`, centralizados en `src/modules/purchases/purchaseAllocation.js`, validan versión/forma y reparten cantidades con `money.splitAmount`. Primero ordenan por ID de persona, de modo que los céntimos sobrantes se asignan por mayor resto y empate estable, nunca por el orden del formulario. Presupuesto esperado e importe real se reparten por separado con los mismos pesos históricos; la suma de cada reparto conserva exactamente sus céntimos.

Una obligación PLANNED usa la propiedad actual. Al pagarse se congela su snapshot. Cambiar después la propiedad, porcentajes o vinculación de usuarios solo afecta a obligaciones aún no pagadas: no modifica snapshots anteriores. Corregir fecha, importe o notas de un pago conserva su snapshot y recalcula únicamente el dinero con esos mismos pesos. Una reversión explícita confirmada limpia pago y snapshot actuales, conservando ambos en auditoría; un nuevo pago posterior captura entonces la propiedad vigente. Un pago existente con snapshot ausente o inválido falla de forma segura y no se reasigna usando la propiedad actual.

**Backfill de pagos existentes de 6.3:** solo se rellenan snapshots para evidencias ya registradas (fecha/importe de contado, fecha de entrada o estado PAID). Se utiliza la propiedad y vinculación disponibles al ejecutar la migración, pues no existía un reparto histórico anterior fiable. Esto no acredita quién era propietario al comprar: es la base inicial explícita para esos pagos heredados. No se inventan pagos, fechas, importes ni cuotas, y los no confirmados permanecen sin snapshot. Los tests ejecutan el SQL de backfill sobre tablas temporales aisladas y comprueban que la evidencia de pago no cambia.

Los snapshots se eliminan de todas las respuestas de Purchase, financiación y cuotas, incluidas mutaciones y listado. Solo el cálculo financiero autorizado consume internamente los pesos: expone el común y la parte personal propia del actor, sin repartir datos privados ajenos al cliente. Archivar conserva los pagos y sus snapshots para el historial financiero; las obligaciones pendientes archivadas se excluyen de la proyección, no se registran como pagadas.

### Cuotas accionables desde detalle y calendario

Cada cuota en detalle devuelve `canRegisterPayment` y `canEditPayment`, calculados por backend. Solo la primera PLANNED global, ordenada por secuencia en toda la financiación y no por el mes visible, permite registrar un pago. Puede abonarse por adelantado aunque su vencimiento sea futuro. PAID no permite registrar otro pago; CANCELLED no permite pagar ni omitir; una compra archivada no ofrece acciones.

El mismo endpoint POST `.../installments/:installmentId/pay` vuelve a comprobar el orden dentro de su transacción Serializable. Una cuota posterior devuelve 409 `PURCHASE_INSTALLMENT_OUT_OF_ORDER`: «Primero registra el pago de la primera cuota pendiente. Puedes pagarla por adelantado.». Tras pagar la primera, la siguiente pasa a ser accionable; si se revierte una cuota anterior, vuelve a ser la primera pendiente. Se mantiene la protección de cuotas PAID contra regeneraciones estructurales.

La cuota conserva su presupuesto en el mes de `dueDate`; su importe real utilizado se contabiliza en el mes de `paidAt`, también en pagos anticipados o atrasados. El contado usa `paymentDate`; la entrada pendiente usa `purchaseDate` para presupuesto y una entrada confirmada usa su `downPaymentPaidAt`. No se ha añadido otra fecha de vencimiento de entrada.

Pruebas de este bloque: `npm test -- tests/purchaseAllocation.test.js` y `PURCHASE_ALLOCATION_DB_TEST=1 npm test -- tests/purchaseAllocation.integration.test.js`. Las fixtures revierten siempre sus datos. CHECKs PostgreSQL exigen snapshots compatibles con el estado del pago, versión 1 y reparto exacto; se comprueba también identidad del hogar.

## Fuentes financieras de compras (fase 6.4)

`loadPurchaseFinancialSources` es la única normalización compra → fuente financiera. Budget, Dashboard, progreso mensual, Calendar, Simulation y Planning consumen esas fuentes sin persistir gastos paralelos. La carga está acotada al periodo de cálculo/calendario y, para próximos pagos de Finance, los doce meses siguientes y las obligaciones atrasadas.

| Fuente | Presupuesto | Utilizado |
| --- | --- | --- |
| `PURCHASE_UPFRONT` | `paidAmountCents` en `paymentDate` confirmado | Mismo importe y mes |
| `PURCHASE_DOWN_PAYMENT` pendiente | `downPaymentCents` en `purchaseDate` | No suma |
| `PURCHASE_DOWN_PAYMENT` pagada | `downPaymentCents` en `downPaymentPaidAt` | Mismo importe y mes |
| `PURCHASE_INSTALLMENT` PLANNED/PAID | `expectedAmountCents` en `dueDate` | Solo PAID: `actualAmountCents` en `paidAt` |
| Cuota CANCELLED | No suma | No suma |

Las líneas de Budget usan `type: "PURCHASE"`, `sourceType`, `purchaseId`, `installmentId` cuando corresponde, `sequence`, `installmentCount`, nombre como «Móvil · Cuota 3/20», `scope`, `personalPersonId`, `ownershipType`, `shareBps` y `canAccessPurchase`. `baseCents` y `amountCents` son la obligación esperada de ese mes; margen adicional cero. `sourceCoverage.purchaseCount` cuenta las líneas de compra visibles del mes. El total del precio del bien nunca se añade otra vez a sus cuotas.

Calendar publica `sourceType: RECURRING_EXPENSE|PURCHASE_UPFRONT|PURCHASE_DOWN_PAYMENT|PURCHASE_INSTALLMENT`. Las cuotas ofrecen los permisos calculados por backend y usan exclusivamente los endpoints PurchaseInstallment. Las entradas se confirman desde la edición de la compra; no se simulan como cuotas ni se pagan por ExpensePayment. El evento permanece en su vencimiento y muestra aparte `paymentDate`; su importe real afecta al utilizado del mes de pago. No existe Omitir para compras.

En SPLIT, todos los importes financieros enviados (`expectedAmountCents`, `actualAmountCents`, `amountCents`) son únicamente la parte personal del visor, no el pago completo. No se envían snapshots, notas de pago ni un desglose personal ajeno. Para registrar/corregir la cuota completa, el cliente renueva la autorización consultando el detalle de Purchase. El backend nunca recibe una parte individual como pago completo por inferencia.

El usuario histórico se autoriza por `linkedUserId` congelado, no por el vínculo actual de la persona. Si conserva historia pero no acceso actual a la compra, ve «Pago histórico de compra», `canAccessPurchase: false` y ninguna acción/enlace. Con otro perfil activo del mismo usuario, solo se remapea la clave interna de agregación, no la asignación persistida. Sin perfil activo, su resumen personal puede existir como «Tú»/`personId: null`; no se añade un participante ficticio al reparto común. Esto amplía la regla anterior de Fase 5, que siempre devolvía personal null sin perfil.

Archivar una compra conserva fuentes PAID históricas y excluye PLANNED futuras; no cancela una deuda con una entidad. Corregir el importe real no altera el esperado; una cuota prevista de 50 € y pagada por 52 € puede producir un exceso de 2 €. La cobertura compara los saldos registrados con el presupuesto restante, sin descontar nuevamente el precio ni mutar cuentas.

### Planificación y privacidad histórica

La preparación persiste `personIdentitySnapshot: [{ personId, linkedUserId }]` dentro de su JSON privado `breakdown`, calculado en la misma transacción que guarda el mes. `/plannings` permite datos personales solo al usuario de esa identidad congelada. El JSON no se envía al cliente. Preparaciones anteriores sin identidad verificable devuelven `personalHistoryRequiresConfirmation: true`, desgloses personales ocultos y saldos personales null; los registros originales no se alteran. El fallback de cobertura y `accountSummary.personal` tampoco utilizan un saldo histórico no autorizado. El usuario puede registrar su saldo actual en Cuentas.

Dashboard y Planning comparan importes y reparto con el presupuesto estándar actual. Si cambian, conservan las aportaciones originales también en la respuesta y añaden `budgetChangedSincePreparation: true`, `preparedHouseholdBudgetCents` y `budgetComparison` con diferencias conjuntas/personales firmadas y líneas de cambio autorizadas. Si falta la identidad histórica, la diferencia personal es `null`, no un cero inventado. El presupuesto vivo de progreso y cobertura sigue en `budget`/`monthlyProgress`; no se mezcla con la transferencia guardada. No se reescribe la preparación ni se modifican saldos. Simulation usa el estándar vivo y añade vencimientos nativos de compras.

Pruebas de las fuentes: `npm test -- tests/purchaseFinancialSources.test.js`; HTTP/BD con rollback: `PURCHASE_FINANCE_DB_TEST=1 npm test -- tests/purchaseFinance.integration.test.js`. Cubren los casos A–D, meses naturales, anticipos, orden global, privacidad/revinculación, historial, cambios futuros, archivado, planificación y ausencia de doble contabilización.

## Análisis privado de tickets y facturas (fase 6.5)

El análisis usa el SDK oficial `openai` únicamente en backend, Responses API y Structured Outputs con JSON Schema estricto. Configuración central: `OPENAI_RECEIPT_MODEL` (por defecto `gpt-5.6-luna`), `OPENAI_API_KEY` opcional al arrancar, `AI_ANALYSIS_LIMIT_PER_HOUR=10`, timeout predeterminado 60 segundos y salida máxima predeterminada 8192 tokens. No hay fallback de modelo, reintentos automáticos, herramientas ni llamadas OpenAI desde React.

```text
POST /api/households/:householdId/purchases/:purchaseId/documents/:documentId/analyze
GET  /api/households/:householdId/purchases/:purchaseId/documents/:documentId/analyses
POST /api/households/:householdId/purchases/:purchaseId/documents/:documentId/analyses/:analysisId/confirm
```

POST analyze exige `{ "consent": true }` y devuelve 201 con el análisis. La interfaz avisa antes de enviar una copia del documento a OpenAI. JPEG/PNG/WebP se envían como `input_image` Base64; PDF como `input_file` Base64 con nombre neutro. Se vuelve a validar MIME, firma y tamaño privado (máximo 10 MiB); nunca se publica una URL, se sube a Files ni se sustituye el archivo original. Todas las llamadas fijan `store:false`. Esta opción no equivale por sí sola a retención cero del proveedor.

Se aplican autenticación, CSRF según la política existente y permisos de la compra/hogar/documento, sin privilegio especial para un OWNER sobre compras personales ajenas. El coste se limita por usuario a diez intentos por hora por defecto, **también en desarrollo**. Límite y bloqueo de análisis simultáneo del mismo documento/usuario usan memoria del proceso: reiniciar la API reinicia esos contadores; un despliegue multiproceso deberá compartir su almacenamiento. No se añade infraestructura distribuida en esta fase.

El proveedor recibe solo los bytes del documento y una instrucción de extracción; no recibe perfiles, reparto ni datos financieros adicionales. El texto del documento se trata como datos no confiables, no como instrucciones. La llamada remota queda fuera de las transacciones serializables y sus reintentos. Antes de leer el archivo y antes de guardar/devolver el resultado se vuelve a comprobar el acceso.

### Salida e historial

Schema estricto, sin campos adicionales:

- `documentType`: `RECEIPT | INVOICE | UNKNOWN`.
- `merchant: { name, confidence }`, `purchaseDate: { value, confidence }`; confianza `HIGH | MEDIUM | LOW` orientativa.
- `currency`, `subtotalCents`, `taxCents`, `discountCents`, `totalCents`, `documentNumber`.
- `items: [{ name, quantity, unitPriceCents, totalPriceCents, brand, model, confidence }]` (máximo 50).
- `needsReview: true` y `warnings`.

Los datos no visibles son `null`, no se completan por conocimiento externo. Validación determinista adicional de fecha civil real, moneda ISO, texto acotado, importes enteros no negativos hasta 2147483647 céntimos y cantidades enteras 1–10000 cuando son conocidas. No se admiten decisiones de propiedad, persona, porcentaje, garantía, método de pago, financiación ni categoría. La comparación de líneas y total añade advertencia cuando la diferencia supera dos céntimos; no inventa un ajuste. IVA, número de documento y demás información auxiliar permanecen en el análisis, no en campos artificiales de Purchase.

Migración aditiva `20260918010000_add_purchase_document_analysis`: `PurchaseDocumentAnalysis` conserva usuario solicitante, documento, proveedor/modelo, estado `COMPLETED | FAILED | CONFIRMED`, `extractedData`, `reviewedData`, tokens input/output/total, código de fallo, timestamps y usuario/fecha de confirmación. Los originales extraídos nunca se reemplazan con las correcciones. Las confirmaciones conservan también qué campos se aplicaron y la aceptación de diferencias. No se guardan precios de tokens ni claves, headers, respuestas crudas o stacks del proveedor.

GET devuelve un array del más reciente al más antiguo; cada elemento incluye un `purchaseVersion` opaco de la compra actual. Reanalizar añade otro registro, no sobrescribe el anterior. Analizar no modifica Purchase, productos, pagos, saldos ni garantías. La eliminación explícita de un documento elimina en cascada sus análisis; archivar conserva documentos e historial bajo la inaccesibilidad existente de las compras archivadas.

### Confirmación humana y protección financiera

Ejemplo de confirmación (el token se obtiene al abrir el análisis):

```json
{
  "purchaseVersion": "<token hexadecimal de 64 caracteres>",
  "reviewedData": {
    "merchant": "Mercadona",
    "purchaseDate": "2026-09-17",
    "totalCents": 870,
    "currency": "EUR",
    "items": [
      { "name": "Producto A", "quantity": 1, "unitPriceCents": 550, "totalPriceCents": 550, "brand": null, "model": null },
      { "name": "Producto B", "quantity": 1, "unitPriceCents": 320, "totalPriceCents": 320, "brand": null, "model": null }
    ]
  },
  "apply": { "merchant": true, "purchaseDate": true, "total": true, "items": "ADD" },
  "acknowledgeTotalMismatch": false
}
```

200 devuelve `{ analysis, purchase }`. El body contiene los **valores revisados**, nunca un simple `confirm=true`; todos se validan de nuevo. `apply` permite conservar campos actuales y `items: "NONE"` no añade productos. ADD exige nombre/cantidad válidos, conserva productos existentes, garantías, números de serie y vínculos documentales; no hay reemplazo destructivo. El `priceCents` de cada producto nuevo registra el total de línea revisado; el precio unitario separado queda en el análisis. La UI exige activar explícitamente la adición, para evitar duplicados accidentales.

La actualización de comercio/fecha/precio reutiliza la misma función transaccional que la edición normal. Cambiar el precio no confirma ni corrige el dinero pagado. Se mantienen las restricciones de financiación con cuotas PAID, estructura y snapshots históricos; una corrección de fecha recalcula las garantías por duración igual que la edición habitual. No se modifica propiedad, reparto, método de pago ni registro de pagos mediante este endpoint. No hay conversión automática de moneda. Una diferencia entre total revisado y suma de líneas exige `acknowledgeTotalMismatch: true`, pero permite guardar tras aceptación explícita.

Compra, productos, estado CONFIRMED y auditoría se guardan atómicamente. Un conflicto de versión devuelve 409 `AI_ANALYSIS_STALE`: hay que recargar la compra y volver a revisar, sin otra llamada a OpenAI. Repetir una confirmación devuelve 409 `AI_ANALYSIS_NOT_CONFIRMABLE`; nunca añade productos dos veces por reintento del mismo análisis.

### Errores y privacidad

Falta de clave: 503 `AI_NOT_CONFIGURED`. Límite propio: 429 `AI_ANALYSIS_RATE_LIMIT` con «Has realizado varios análisis en poco tiempo. Inténtalo más tarde.». Se distinguen errores seguros de autenticación/cuota/límite del proveedor, timeout, rechazo, respuesta incompleta y schema inválido. El mensaje público no incluye detalles internos. Los intentos que alcanzan el proveedor se conservan como FAILED cuando el usuario mantiene acceso al documento; los fallos previos de permiso/archivo no crean una extracción.

Auditoría solo de identificadores, estado, modelo, usage, códigos de fallo y campos aplicados. Las rutas documentales no registran mensajes/stacks crudos ni en desarrollo, incluido un JSON malformado antes del router. El logger redacta además bytes, Base64, extracciones, revisiones, números de serie e IMEI. Respuestas privadas `Cache-Control: private, no-store`.

Los tests automatizados inyectan proveedor/fetch simulados: no envían tickets reales ni consumen tokens facturados. `PURCHASE_ANALYSIS_DB_TEST=1 npm test -- tests/purchaseAnalysis.integration.test.js tests/purchaseAnalysisConcurrency.integration.test.js` cubre confirmación y carreras con PostgreSQL local aislado; ambas confirmaciones compiten en transacciones reales, no con una serialización simulada. La verificación final completa pasa con 876 tests backend y 673 frontend; Prisma validate, lint y build correctos. Para la configuración del servidor, véase [README](../README.md#configuración-de-openai).

## Notificaciones, preferencias y push

```text
GET    /api/notifications
PATCH  /api/notifications/read-all
PATCH  /api/notifications/:notificationId/read

GET    /api/notification-preferences
PATCH  /api/notification-preferences

GET    /api/households/:householdId/recurring-expenses/:expenseId/reminder-rules
PUT    /api/households/:householdId/recurring-expenses/:expenseId/reminder-rules

GET    /api/push-subscriptions
POST   /api/push-subscriptions
DELETE /api/push-subscriptions/:subscriptionId
```

Notifications pagina con `page`, `pageSize` y `unreadOnly`. Preferencias admite canales y offsets por defecto. Reminder-rules sustituye atómicamente las reglas del usuario para el gasto. La respuesta de push nunca expone claves privadas VAPID.

## Health y errores operativos

`GET /api/health` es liveness y no consulta PostgreSQL. El rate limit general cubre `/api` salvo health; autenticación añade límites por IP y, cuando hay email, por cuenta normalizada. `X-Request-Id` conserva IDs seguros o genera un UUID.
