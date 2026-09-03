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
```

DELETE de un recurrente es un archivado lógico. Al registrar un pago, `KEEP_PREVIOUS` conserva `amountCents`; `UPDATE_NEXT_AMOUNT` solo es válido para `PAID` y copia el importe real al siguiente importe previsto. El histórico guarda previsto, real, fecha y decisión.

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

## Gastos variables

```text
GET    /api/households/:householdId/variable-expenses
PUT    /api/households/:householdId/variable-expenses/month
GET    /api/households/:householdId/variable-expenses/statistics
DELETE /api/households/:householdId/variable-expenses/:variableMonthId
```

El PUT recibe `{ categoryId, scope, personalPersonId?, year, month, entryMode, summaryAmountCents?, entries?, notes? }`. `SUMMARY` exige total y prohíbe entries. `DETAIL` prohíbe total resumen y calcula desde entries. Para las medias, la aplicación usa automáticamente solo los meses anteriores al mes de cálculo; el mes en curso todavía no entra en el promedio. El cambio se hace en transacción y las constraints/triggers de PostgreSQL impiden mezclar ambos modos incluso con escrituras concurrentes.

## Presupuesto, saldo, planificación y simulación

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

Budget no recibe query y devuelve el presupuesto estándar. Dashboard y Simulation aceptan `date` y `balanceCents` en query; Simulation es GET y no persiste. Dashboard incluye `household.contributionDay` para distinguir el estado previo a la aportación habitual. Balance recibe `{ balanceCents }` y crea snapshot. Plannings admite filtros `year`/`month`; prepare recibe `{ calculationDate, confirmedBalanceCents }` y crea o actualiza el snapshot mensual de forma serializable. Calendar acepta `view=MONTH|30_DAYS|90_DAYS|YEAR` y `anchorDate`.

Recovery preview no persiste. En modo `RECOMMENDED` usa el saldo conjunto, la aportación mensual estándar y los meses naturales inclusivos hasta cada vencimiento común. Además de importe y duración devuelve `recommendation`, con la base suave, el mínimo exigido por flujo de caja y el vencimiento limitante. Crear un plan cancela el anterior activo; PATCH admite `COMPLETED` o `CANCELLED`.

Calendar fusiona las ocurrencias futuras activas con `ExpensePayment`: un mismo `expenseId + dueDate` aparece una sola vez y los estados `PAID`/`SKIPPED` históricos siguen visibles después de avanzar `nextDueDate` o archivar el recurrente de pago único. En esos eventos `amountCents` usa el importe real pagado cuando existe y también se devuelven previsto, real y fecha de pago.

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
