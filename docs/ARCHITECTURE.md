# Arquitectura de BudgetApp

Estado: arquitectura backend implementada y contratos HTTP vigentes.

Esta decisión cubre el sistema completo, aunque cliente y servidor viven en repositorios Git independientes. La fuente de verdad financiera y de autorización es siempre el servidor. El cliente presenta resultados, captura datos y mantiene caché de servidor; no replica fórmulas de negocio.

## 1. Arquitectura implementada

BudgetApp es un monolito modular con API HTTP independiente:

```text
Navegador React
  -> HTTPS + cookies HttpOnly + cabecera CSRF
API Express
  -> controladores y validación Zod
  -> servicios de dominio
  -> Prisma ORM
  -> PostgreSQL

Scheduler node-cron opcional
  -> mismos servicios de dominio
  -> email / Web Push
```

Decisiones:

- Dos repositorios: `BudgetApp-Cliente` y `BudgetApp-Servidor`. No hay workspaces compartidos ni dependencias por ruta.
- API REST bajo `/api`; una futura versión incompatible podrá publicarse bajo `/api/v2` sin acoplar el cliente web.
- Arquitectura por dominio, con auth en controladores/servicios y hogar/finanzas/notificaciones en módulos cohesivos.
- Prisma y PostgreSQL son la capa persistente. Los servicios financieros y de hogar aceptan un cliente transaccional para operaciones atómicas.
- Dinero como `Int` en céntimos. Porcentajes como puntos básicos (`1000` = `10,00 %`; `10000` = `100 %`).
- Fechas civiles se reciben como ISO `YYYY-MM-DD`, se interpretan en la zona horaria del hogar y se guardan como `DATE` cuando no representan un instante.
- Cálculos financieros puros y deterministas en `src/services/budgetCalculator.service.js` y módulos auxiliares. No dependen del reloj del proceso; reciben las fechas de forma explícita.
- El presupuesto mensual estándar se calcula exclusivamente con configuración e históricos. `simulationDate` solo participa en reserva, vencimientos, riesgo, déficit y recuperación.
- Roles de acceso y personas económicas son relaciones distintas. `HouseholdPerson` no necesita cuenta.
- Los efectos externos se diseñan de forma idempotente. Una notificación se persiste antes de intentar enviarla.
- Servicios opcionales (Google, SMTP y Web Push) se activan por configuración y no impiden el uso local básico si están desactivados.

El backend usa Prisma 6 porque el entorno actual ejecuta Node `20.18.3`; Prisma 7 exige al menos Node `20.19.0` y Prisma 8 exige Node 24. Prisma 6 sigue siendo compatible con este runtime. La actualización se hará de manera explícita junto con Node, no instalando una versión incompatible.

## 2. Estructura frontend

```text
BudgetApp-Cliente/
├── docs/
├── public/
├── src/
│   ├── api/
│   │   ├── client.js
│   │   ├── errors.js
│   │   └── queryKeys.js
│   ├── app/
│   │   ├── App.jsx
│   │   ├── providers.jsx
│   │   ├── queryClient.js
│   │   └── router.jsx
│   ├── components/
│   │   ├── feedback/
│   │   ├── layout/
│   │   └── ui/
│   ├── features/
│   │   ├── auth/
│   │   ├── calendar/
│   │   ├── dashboard/
│   │   ├── expenses/
│   │   ├── household/
│   │   ├── notifications/
│   │   └── planning/
│   ├── hooks/
│   ├── pages/
│   ├── styles/
│   ├── test/
│   └── utils/
├── .env.example
├── eslint.config.js
├── index.html
├── package.json
└── vite.config.js
```

Pautas:

- Los módulos de `features` agrupan API, hooks, schemas y componentes propios del dominio.
- `components/ui` contiene primitivas sin conocimiento de negocio; no se crea una variante si una existente resuelve el caso.
- React Query almacena estado remoto. Estado efímero local permanece en React; Jotai solo se añadirá si aparece estado cliente global real.
- La navegación móvil tiene cinco destinos: Inicio, Gastos, Calendario, Planificación y Más. En escritorio se usa barra lateral.
- Las rutas públicas y privadas tienen layouts distintos. La sesión inicial usa un estado de carga accesible.
- Axios usa `withCredentials`, timeout, token CSRF y un único refresh concurrente. Nunca lee ni persiste tokens de autenticación.

## 3. Estructura backend

```text
BudgetApp-Servidor/
├── docs/
├── prisma/
│   ├── migrations/
│   ├── schema.prisma
│   └── seed.js
├── src/
│   ├── config/
│   │   ├── cors.js
│   │   └── env.js
│   ├── controllers/
│   ├── errors/
│   ├── lib/
│   │   └── prisma.js
│   ├── jobs/
│   │   ├── reminder.job.js
│   │   └── reminder.scheduler.js
│   ├── middleware/
│   ├── modules/
│   │   ├── access/
│   │   ├── categories/
│   │   ├── finance/
│   │   ├── household-domain/
│   │   ├── households/
│   │   ├── invitations/
│   │   ├── notifications/
│   │   └── people/
│   ├── routes/
│   ├── services/
│   ├── utils/
│   └── validators/
├── tests/
├── .env.example
├── app.js
├── eslint.config.js
└── package.json
```

Una petición sigue `route -> Zod -> autenticación/autorización -> servicio/cálculo -> Prisma`. `src/app.js` crea una sola instancia de los middleware de autenticación y CSRF y la inyecta en todos los routers. `requireHouseholdRole`, `requireHouseholdPerson` y `requireHouseholdCategory` aceptan Prisma o el cliente transaccional.

## 4. Schema Prisma completo

El schema ejecutable está en [`prisma/schema.prisma`](../prisma/schema.prisma). Sus grupos son:

- Identidad: `User`, `OAuthAccount`, `RefreshSession`, `PasswordResetToken`, `LegalDocumentAcceptance`.
- Hogar: `Household`, `HouseholdPerson`, `HouseholdUserAccess`, `Invitation`, `HouseholdBalanceSnapshot`.
- Presupuesto: `Category`, `RecurringExpense`, `ExpensePayment`, `UtilityInvoice`, `InvoiceDocument`, `VariableExpenseMonth`, `VariableExpenseEntry`.
- Planificación: `MonthlyPlanning`, `MonthlyPlanningContribution`, `RecoveryPlan`.
- Notificaciones: `NotificationPreference`, `ReminderRule`, `Notification`, `NotificationDelivery`, `PushSubscription`.
- Trazabilidad: `AuditLog`.

Restricciones centrales:

- Un acceso por usuario y hogar.
- Una persona vinculada por usuario y hogar.
- Un plan preparado por hogar, año y mes.
- Un bloque variable por categoría, persona/ámbito y mes; su `entryMode` impide mezclar resumen y detalle.
- Una notificación por `userId + expenseId + dueDate + offset` y una entrega por `notificationId + channel`; juntas forman la clave idempotente completa sin duplicar campos.
- Tokens de sesión, recuperación e invitación se persisten únicamente mediante hash.
- Cada alta conserva una evidencia versionada `PRIVACY_POLICY` con origen `REGISTRATION`, sin IP y única por usuario, tipo y versión. La aplicación no expone operaciones para modificarla; acompaña al usuario si se ejecuta una futura supresión de cuenta.
- `InvoiceDocument` guarda bytes en PostgreSQL `BYTEA`, tamaño y MIME comprobados, nombre saneado y usuario que subió el archivo. Cada consulta JSON usa `select` explícito para excluir `content`.
- Las filas financieras históricas se conservan con `Restrict` o `SetNull`; no se destruyen al borrar una cuenta.

Las reglas que Prisma no expresa en el schema —rangos de puntos básicos, mes 1..12 y consistencia resumen/detalle— se validan con Zod/servicios y están reforzadas mediante constraints y triggers en la migración inicial. Las ampliaciones, como la evidencia legal versionada, viven en migraciones incrementales nuevas.

## 5. Diagrama textual de relaciones

```text
User
├── OAuthAccount
├── RefreshSession
├── PasswordResetToken
├── LegalDocumentAcceptance
├── HouseholdUserAccess ── Household
├── linkedPerson? ───────── HouseholdPerson ── Household
├── NotificationPreference
├── PushSubscription
└── AuditLog (actor opcional)

Household
├── HouseholdPerson
├── HouseholdUserAccess
├── Invitation ──────────── HouseholdPerson? / inviter User
├── Category
│   ├── RecurringExpense ── HouseholdPerson? (si PERSONAL)
│   │   ├── ExpensePayment
│   │   └── ReminderRule ── User
│   ├── UtilityInvoice
│   │   └── InvoiceDocument ── uploader User?
│   └── VariableExpenseMonth ── HouseholdPerson?
│       └── VariableExpenseEntry
├── HouseholdBalanceSnapshot
├── MonthlyPlanning
│   ├── MonthlyPlanningContribution ── HouseholdPerson
│   └── RecoveryPlan?
├── Notification
│   └── NotificationDelivery
└── AuditLog
```

`HouseholdUserAccess` responde quién puede operar. `HouseholdPerson` responde quién participa en el reparto. Vincularlas es opcional y nunca sustituye la comprobación de acceso.

## 6. Endpoints

Todos responden `{ "success": true, "data": ... }` o `{ "success": false, "code": "...", "message": "..." }`. El inventario contractual completo, incluidos bodies y queries clave, está en [`API.md`](API.md). Las rutas montadas son:

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

GET|POST       /api/households
GET|PATCH      /api/households/:householdId
POST           /api/households/:householdId/archive
GET|POST       /api/households/:householdId/people
PATCH          /api/households/:householdId/people/:personId
PUT            /api/households/:householdId/people/distribution
POST           /api/households/:householdId/people/:personId/archive
GET            /api/households/:householdId/access
PATCH|DELETE   /api/households/:householdId/access/:accessId
POST           /api/households/:householdId/ownership-transfer
GET|POST       /api/households/:householdId/invitations
DELETE         /api/households/:householdId/invitations/:invitationId
POST           /api/invitations/preview
POST           /api/invitations/accept

GET|POST       /api/households/:householdId/categories
PATCH          /api/households/:householdId/categories/:categoryId
POST           /api/households/:householdId/categories/:categoryId/archive
DELETE         /api/households/:householdId/categories/:categoryId

GET|POST       /api/households/:householdId/recurring-expenses
GET|PATCH|DELETE /api/households/:householdId/recurring-expenses/:expenseId
GET|POST       /api/households/:householdId/recurring-expenses/:expenseId/payments

GET|POST       /api/households/:householdId/invoices
GET            /api/households/:householdId/invoices/statistics
PATCH|DELETE   /api/households/:householdId/invoices/:invoiceId
GET|POST       /api/households/:householdId/invoices/:invoiceId/documents
GET            /api/households/:householdId/invoices/:invoiceId/documents/:documentId/content
DELETE         /api/households/:householdId/invoices/:invoiceId/documents/:documentId

GET            /api/households/:householdId/variable-expenses
PUT            /api/households/:householdId/variable-expenses/month
GET            /api/households/:householdId/variable-expenses/statistics
DELETE         /api/households/:householdId/variable-expenses/:variableMonthId

GET            /api/households/:householdId/budget
GET            /api/households/:householdId/dashboard
GET            /api/households/:householdId/simulation
GET            /api/households/:householdId/calendar
PATCH          /api/households/:householdId/balance
GET            /api/households/:householdId/plannings
POST           /api/households/:householdId/plannings/prepare
PATCH          /api/households/:householdId/plannings/:planningId/fund
GET|POST       /api/households/:householdId/recovery-plans
POST           /api/households/:householdId/recovery-plans/preview
PATCH          /api/households/:householdId/recovery-plans/:recoveryPlanId

GET            /api/notifications
PATCH          /api/notifications/read-all
PATCH          /api/notifications/:notificationId/read
GET|PATCH      /api/notification-preferences
GET|PUT        /api/households/:householdId/recurring-expenses/:expenseId/reminder-rules
GET|POST       /api/push-subscriptions
DELETE         /api/push-subscriptions/:subscriptionId
```

Cada `householdId` y recurso hijo se resuelve contra el usuario autenticado. Invitation preview es la única operación de hogar pública. Simulation y recovery preview no persisten; los restantes métodos mutables requieren CSRF.

Los documentos de factura siguen los permisos financieros existentes: cualquier miembro activo del hogar puede listar, subir, descargar y borrar. Upload autentica y valida CSRF antes de leer el body, recibe el nombre codificado en `X-Document-Filename` para excluirlo de la URL, limita a 10 MiB, contrasta MIME con magic bytes y terminadores/longitud básicos, sustituye la extensión por la canónica del MIME validado y ejecuta `count + create` con aislamiento serializable para mantener el máximo de 5 incluso con concurrencia. El contenido solo sale por el endpoint binario `/content` como `attachment`, sin ETag, con `nosniff`, CSP sandbox y `Cache-Control: private, no-store`. El listado de facturas devuelve únicamente `documentCount`; solo el endpoint dedicado carga metadatos y ninguno carga el `BYTEA` en JSON.

Los archivos son contenido no confiable. Estas comprobaciones detectan formatos falsos o truncados, pero no son antivirus ni CDR. Un despliegue de producción debe revisar escaneo, cuarentena, almacenamiento de objetos privado, cifrado y retención de backups según volumen y riesgo antes de permitir documentos reales.

## 7. Flujo de autenticación

1. Registro normaliza el correo, valida contraseña y exige confirmación literal de lectura de la versión vigente publicada por `/legal/privacy-policy`. Usuario, evidencia legal versionada, sesión y auditoría se crean en la misma transacción. La contraseña se guarda como hash bcrypt; nunca se recorta ni se registra.
2. Login usa una respuesta genérica para credenciales inválidas y límites por IP/cuenta.
3. El servidor emite un access JWT de 15 minutos en cookie `HttpOnly`, con `iss`, `aud`, algoritmo y expiración explícitos.
4. El refresh es un JWT firmado con secreto independiente, `sessionId`, familia y `jti` aleatorio, enviado en otra cookie `HttpOnly`. En PostgreSQL solo se guarda SHA-256 del token completo, familia, caducidad y metadatos limitados.
5. Cada refresh rota el token dentro de una transacción. Reutilizar un token rotado revoca toda la familia.
6. Axios nunca ve los tokens. Ante varios 401, una promesa compartida ejecuta un solo refresh y reintenta una vez.
7. Los métodos mutables requieren un token CSRF firmado, expuesto como valor no sensible y enviado en `X-CSRF-Token`; también se valida `Origin`.
8. Logout revoca la sesión actual y limpia cookies. Logout-all revoca todas las sesiones. `GET /auth/sessions` lista dispositivos sin hashes ni tokens y DELETE permite revocar uno.
9. Forgot-password responde siempre el mismo texto. Guarda hash de token opaco, TTL y uso único.
10. Reset consume token, cambia contraseña y revoca sesiones en una misma transacción.

## 8. Flujo Google Login

1. El usuario pulsa “Continuar con Google”; nunca se inicia automáticamente.
2. `/google/start` genera `state` y PKCE, conserva el verificador en una cookie temporal HttpOnly y redirige a Google. Cuando puede producirse un alta, valida la versión declarada y firma en el estado la confirmación y la versión decidida por el servidor.
3. El callback valida `state`, intercambia el código en backend y verifica firma, issuer, audience, expiración y `email_verified` del ID token.
4. Si ya existe `OAuthAccount(provider, providerAccountId)`, se crea la misma sesión segura que en login normal.
5. Si no existe usuario con ese correo verificado, solo se crea usuario Google si el estado firmado confirma la versión que continúa vigente; usuario, evidencia legal, cuenta OAuth, sesión y auditoría comparten transacción.
6. Si existe una cuenta local con el mismo correo, no se enlaza por coincidencia de texto durante una sesión anónima. Una sesión local activa del mismo usuario permite vincular; en otro caso se exige la contraseña local mediante una cookie temporal HttpOnly de diez minutos.
7. Google no crea ni vincula automáticamente `HouseholdPerson`; esa relación se gestiona mediante personas e invitaciones para evitar duplicados.

## 9. Fórmulas financieras

Todas las operaciones redondean una sola vez al céntimo con división entera y resto. El reparto final usa “mayor resto” y un desempate estable por ID para que las partes sumen exactamente el total.

### Mensualización de gastos conocidos

```text
WEEKLY        = amountCents * 52 / 12
MONTHLY       = amountCents
BIMONTHLY     = amountCents / 2
QUARTERLY     = amountCents / 3
SEMIANNUAL    = amountCents / 6
YEARLY        = amountCents / 12
CUSTOM_MONTHS = amountCents / intervalMonths
```

`ONE_TIME` no altera permanentemente el presupuesto estándar. Se incorpora a la planificación de caja y a la reserva hasta su vencimiento.

### Facturas por periodo

Los extremos de factura se consideran inclusivos:

```text
periodDays       = calendarDifference(periodEnd, periodStart) + 1
dailyCost        = amountCents / periodDays
monthlyEquivalent = round(amountCents * 3044 / (periodDays * 100))
```

La media histórica ponderada es:

```text
round(sum(invoiceAmountCents) * 3044 / (sum(periodDays) * 100))
```

Las ventanas 3/6/12 se anclan a la última factura guardada, no a `simulationDate`.

### Variables

Solo participan los meses anteriores al mes de cálculo. El mes en curso todavía no entra en la media y un mes ausente no vale cero. Las ventanas se anclan al último mes terminado guardado e informan `availableMonths` si hay menos datos de los solicitados.

`SUMMARY` exige un total mensual y no admite apuntes. `DETAIL` exige total resumen nulo y calcula desde sus entries. Zod rechaza formas mixtas; la migración añade checks y triggers para mantener la exclusividad también ante concurrencia.

### Pagos y siguiente importe

El pago conserva importe previsto, real y fecha. `KEEP_PREVIOUS` no modifica el recurrente. `UPDATE_NEXT_AMOUNT` solo se admite en un pago `PAID` y copia exactamente el importe real a `RecurringExpense.amountCents` para el ciclo siguiente; nunca cambia el importe de forma implícita.

El calendario no deriva el histórico desde el puntero mutable `nextDueDate`. Genera por separado las ocurrencias futuras de recurrentes activos y los eventos históricos desde `ExpensePayment`, incluidos los pertenecientes a recurrentes archivados. Después los fusiona por `expenseId + dueDate`, dando prioridad al pago, para conservar `PAID`/`SKIPPED` sin duplicar una ocurrencia futura ya registrada.

### Margen y reparto

```text
effectiveMarginBps = expenseOverride ?? categoryMargin ?? householdMargin
recommendedCents   = round(baseCents * (10000 + effectiveMarginBps) / 10000)
householdShare     = splitAmount(householdBudgetCents, activeContributionBps)
personTotal        = householdShare + personalRecommendedCents + temporaryAdjustmentCents
```

La suma de aportaciones activas debe ser `10000` en modo porcentual.

### Reserva teórica

Para cada gasto periódico no mensual con ciclo conocido:

```text
cycleProgress = clamp(elapsedCycleDays / totalCycleDays, 0, 1)
expenseReserve = round(targetAmountCents * cycleProgress)
theoreticalReserve = sum(expenseReserve)
deficit = max(0, theoreticalReserve - relevantAvailableBalance)
```

`simulationDate` cambia `cycleProgress`, próximos pagos y déficit, pero jamás las mensualizaciones ni medias estándar.

## 10. Flujo preparar mes

1. Dashboard sirve como cálculo previo y obtiene presupuesto, reserva, vencimientos y estado sin persistir.
2. El cliente envía `{ calculationDate, confirmedBalanceCents }` a `POST /plannings/prepare`.
3. El backend exige reparto listo y calcula aportaciones, personales, reserva y ajuste temporal activo.
4. En una transacción serializable crea o actualiza el `MonthlyPlanning` único del año/mes, reemplaza sus contribuciones, actualiza saldo, crea snapshot y auditoría.
5. `PATCH /plannings/:planningId/fund` marca como financiado el snapshot preparado.
6. El dashboard diferencia estándar, ajuste temporal y total. El saldo sirve para evaluar cobertura; no reduce silenciosamente la aportación estándar.

## 11. Flujo recuperación de déficit

El preview no modifica datos.

- Objetivo en X meses: `monthlyAdjustment = ceil(deficit / months)`.
- Máximo X al mes: `estimatedMonths = ceil(deficit / maximumMonthlyAmount)`.
- Recomendado: ordenar los vencimientos comunes por su fecha real. Para cada prefijo se calculan los meses naturales inclusivos entre `startsOn` y el vencimiento y se evalúa:

```text
availableWithoutAdjustment = currentBalance + standardMonthlyBudget * monthsAvailable
prefixShortfall = max(0, cumulativeUpcomingPayments - availableWithoutAdjustment)
requiredMonthlyAdjustment = ceil(prefixShortfall / monthsAvailable)
```

  La recomendación es el mayor mínimo de flujo de caja o `ceil(deficit / 12)`, sin superar el déficit total. Los gastos personales quedan fuera. La respuesta identifica la aportación estándar utilizada, la base suave y el vencimiento limitante; no usa la posición del pago como sustituto del tiempo.

Al guardar:

1. Se registra déficit inicial, modo, ajuste y horizonte.
2. El ajuste común se reparte con los mismos porcentajes y mayor resto.
3. Cada preparación mensual conserva estándar y ajuste en columnas separadas.
4. Crear un plan cancela cualquier plan activo anterior del hogar; los históricos se conservan.
5. PATCH permite cerrarlo explícitamente como `COMPLETED` —saldo restante cero— o `CANCELLED`.

## 12. Sistema de notificaciones

```text
node-cron opcional en el proceso API
  -> src/jobs/reminder.scheduler.js
  -> runReminderJob(now)
  -> selecciona vencimientos + reglas + preferencias
  -> inserta Notification/Delivery idempotente
  -> reclama cada Delivery con PENDING -> PROCESSING de forma atómica
  -> adaptador IN_APP | EMAIL | WEB_PUSH
  -> registra SENT/FAILED, libera el claim y programa reintentos
```

- El job recibe `now`, por lo que se prueba sin reloj global.
- La clave única equivale a `userId + expenseId + dueDate + offset + channel`.
- Repetir el job trata el conflicto único como “ya procesado”, no como error.
- Varios workers intentan reclamar mediante `updateMany` condicionado por estado; solo el que actualiza la fila entrega el mensaje.
- Los fallos programan backoff exponencial acotado. No se promete exactamente-una-vez entre PostgreSQL y SMTP/Push.
- Email y push se omiten cuando el canal está desactivado, sin afectar IN_APP.
- Push solicita permiso solo después del botón “Activar notificaciones”.
- `REMINDER_JOB_ENABLED` controla el scheduler y `REMINDER_JOB_CRON` su expresión; usa la zona IANA por defecto y evita solapes dentro del proceso.
- `app.js` lo inicia después de escuchar y lo detiene/destruye durante shutdown. La lógica del job permanece separada y recibe `now` en pruebas.

## 13. `.env.example` backend completo

El archivo ejecutable y comentado vive en [`../.env.example`](../.env.example). Incluye app, base de datos, CORS, JWT, cookies, CSRF, bcrypt, Google, SMTP, VAPID, jobs, rate limits, tokens, valores financieros y logs. `DATABASE_URL`, secretos JWT y CSRF son obligatorios. Google, SMTP y Push son obligatorios únicamente cuando su feature flag está activa. Los límites de documentos de factura son invariantes fijas de producto, no variables de entorno.

## 14. `.env.example` frontend completo

Está en el repositorio cliente. Solo contiene configuración pública `VITE_*`: URL de API, nombre, Google client ID, VAPID pública y flags. Nunca recibe secretos, URL de base de datos ni tokens.

## 15. Estado por fases

El backend tiene montados base, auth, hogares/personas/accesos/invitaciones/categorías, recurrentes/pagos, facturas y sus documentos, variables, presupuesto/dashboard, planificación/simulación/recuperación, calendario y notificaciones/push. Las reglas críticas disponen de tests unitarios y HTTP. La cobertura funcional del cliente se versiona en su repositorio independiente y no se infiere de este documento backend.

El endurecimiento operativo pendiente no añade rutas ficticias aquí: store distribuido para rate limit y validación end-to-end con proveedores Google/SMTP/Push reales antes de producción. Los deliveries que quedan bloqueados tras una caída se recuperan automáticamente al superar el tiempo de lease.

## 16. Riesgos técnicos

- Fechas y DST: usar fechas civiles y zona del hogar; nunca construir `new Date('YYYY-MM-DD')` para lógica financiera local.
- Redondeo: centralizar división y reparto; tests de suma exacta y límites `Number.MAX_SAFE_INTEGER`.
- Históricos escasos: nunca interpretar ausencia como cero y devolver metadatos de cobertura.
- Concurrencia: preparar mes, aceptar invitación, rotar refresh y registrar pago requieren constraints y transacciones.
- Cookies cross-site: despliegues en dominios distintos requieren `SameSite=None; Secure`, HTTPS y CSRF/Origin estrictos.
- Account linking: coincidir email no basta para apropiarse de una cuenta existente.
- Jobs: SMTP/push puede fallar después del commit; persistir estado y reintentar con idempotencia.
- Prisma/runtime: no subir a una major incompatible con Node sin una tarea de migración explícita.
- Reservas: comunicar que son una recomendación teórica sobre un saldo global, no cuentas ni dinero segregado.
- Escala: dashboard debe evitar N+1 y calcular agregados con consultas acotadas, pero no se introducirá caché prematura.

## 17. Condiciones operativas y supuestos

No hay bloqueos de código conocidos para arrancar localmente. Son necesarias una base PostgreSQL migrada y tres secretos distintos. Google, SMTP, Web Push y el scheduler permanecen desactivados hasta aportar configuración válida.

Supuestos documentados y reversibles:

- Los periodos de factura incluyen fecha inicial y final.
- El gasto `ONE_TIME` afecta planificación/reserva, no el estándar permanente.
- EUR, `es-ES` y `Europe/Madrid` son defaults, no constantes de dominio.
- Google, SMTP y Web Push comienzan desactivados hasta aportar credenciales.
- Las migraciones desplegadas se aplican con `prisma migrate deploy`; jamás se usa reset automático sobre datos reales.
