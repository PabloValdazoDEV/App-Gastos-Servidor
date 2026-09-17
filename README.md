# BudgetApp Servidor

API independiente para presupuesto, previsión y planificación económica del hogar. No es una API bancaria ni contable: trabaja con un saldo conjunto global, gastos configurados, históricos y planificación.

## Estado

El backend funcional está montado: base Express/Prisma, autenticación local y Google opcional, hogares/personas/accesos/invitaciones/categorías, recurrentes y pagos, facturas con documentos opcionales, variables, presupuesto/dashboard, planificación/simulación/recuperación, calendario, notificaciones, push y scheduler opcional. [`docs/API.md`](docs/API.md) es el inventario exacto de rutas vigentes.

## Requisitos

- Node.js `20.18.3` (archivo `.nvmrc`).
- npm 10 o compatible con lockfile v3.
- PostgreSQL para migraciones y funciones con persistencia.

Se usa Prisma `6.12.0` porque el runtime disponible no alcanza el mínimo de Prisma 7 y esta versión evita dependencias transitivas con avisos de seguridad presentes en releases 6.x posteriores. Cliente y CLI están fijados a la misma versión.

## Puesta en marcha

```bash
npm install
cp .env.example .env
```

Completa `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` y `CSRF_SECRET`. Genera secretos independientes:

```bash
openssl rand -base64 64
```

Prepara la base e inicia:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

El servidor falla con un mensaje explícito si la configuración obligatoria es inválida. `GET /api/health` no necesita conectar a la base de datos. En arranques posteriores basta `npm run dev` si dependencias y migraciones no han cambiado.

El servidor también arranca si los metadatos `PRIVACY_*` están vacíos, pero las altas quedan bloqueadas de forma segura. Para habilitar registro local o creación de una cuenta Google nueva, configura versión y fecha de vigencia de la política, nombre y correo del responsable. Dirección y correo del DPO son opcionales. Consulta [Entorno](docs/ENVIRONMENT.md); `GET /api/legal/privacy-policy` permite comprobar el estado público sin exponer secretos.

Los documentos de factura son opcionales y no requieren variables de entorno: se guardan en PostgreSQL, con un máximo fijo de 5 por factura y 10 MiB por archivo. La API admite PDF, JPEG, PNG y WebP, y los entrega siempre como descarga. Antes de producción revisa las advertencias de seguridad, privacidad y almacenamiento de [Arquitectura](docs/ARCHITECTURE.md).

Seed local opcional:

```bash
npm run seed
```

## Configuración de OpenAI

El análisis opcional de tickets/facturas usa el SDK oficial `openai` **solo en el servidor**, con Responses API y un JSON Schema estricto. Configura en el entorno del backend:

```dotenv
OPENAI_API_KEY=
OPENAI_RECEIPT_MODEL=gpt-5.6-luna
AI_ANALYSIS_LIMIT_PER_HOUR=10
OPENAI_RECEIPT_TIMEOUT_MS=60000
OPENAI_RECEIPT_MAX_OUTPUT_TOKENS=8192
```

Introduce la clave únicamente en el servidor, nunca en Git, ejemplos, logs ni variables `VITE_*`. Sin clave, la aplicación normal arranca y la acción de análisis responde `AI_NOT_CONFIGURED`. El modelo se configura en un solo lugar; no existe fallback automático a modelos más caros.

Los bytes privados JPEG/PNG/WebP se envían como `input_image` Base64 y los PDF como `input_file` Base64, sin URL pública ni subida a Files/Vector Stores. Cada llamada fija `store:false`, sin herramientas, sin reintentos automáticos y con timeout total (entre 1 y 120 segundos). El límite de salida admite entre 1024 y 16384 tokens; el límite local por usuario es configurable. No se registran contenido, Base64, cabeceras ni errores internos del proveedor.

La salida se valida de nuevo (fechas reales, moneda, enteros, productos e incoherencias de importes), conserva `null` en lo desconocido y siempre requiere revisión. Analizar solo genera un borrador: aplicar los datos exige confirmación explícita y mantiene las restricciones financieras existentes. Los tests usan mocks y no realizan llamadas de pago. `store:false` desactiva el almacenamiento de Responses, pero no constituye por sí solo una garantía de retención cero del proveedor; revisa sus [controles de datos](https://developers.openai.com/api/docs/guides/your-data) antes de producción.

Referencias oficiales: [modelo](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [imágenes](https://developers.openai.com/api/docs/guides/images-vision), [archivos](https://developers.openai.com/api/docs/guides/file-inputs).

## Scripts

```bash
npm run dev                  # desarrollo con nodemon
npm start                    # ejecución normal
npm run lint                 # ESLint
npm test                     # Vitest
npm run test:watch           # Vitest interactivo
npm run prisma:validate      # validar schema
npm run prisma:generate      # generar cliente
npm run prisma:migrate       # migración de desarrollo
npm run prisma:migrate:deploy
npm run prisma:studio
npm run seed
```

El seed, que se niega a ejecutarse en producción, crea la cuenta ficticia `demo.owner@budgetapp.local` con contraseña `Demo-password-1!`. Ejecutarlo otra vez restaura esa contraseña únicamente para la cuenta demo.

No ejecutes `migrate reset`, `DROP DATABASE`, `DROP TABLE` ni aceptes una migración destructiva sin revisión y autorización. El flujo seguro está en [`docs/DATABASE_INVARIANTS.md`](docs/DATABASE_INVARIANTS.md).

## Estructura

```text
app.js                 entrada y cierre ordenado
src/app.js             factory Express comprobable
src/config/            entorno y CORS
src/errors/            errores operativos
src/lib/               Prisma y logger
src/jobs/              job idempotente y scheduler de recordatorios
src/middleware/        contexto, autenticación, CSRF, límites y errores
src/modules/           hogares, finanzas y notificaciones
src/controllers/       adaptación HTTP de cada dominio
src/services/          autenticación y reglas de negocio
src/validators/        contratos Zod
src/routes/            routers HTTP
prisma/schema.prisma   modelo completo inicial
prisma/migrations/     migraciones versionadas e invariantes PostgreSQL
tests/                  pruebas unitarias, de invariantes y HTTP
docs/                   arquitectura y operación
```

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Entorno](docs/ENVIRONMENT.md)
- [Invariantes de base de datos](docs/DATABASE_INVARIANTS.md)
- [Google OAuth](docs/GOOGLE_AUTH.md)
- [Email](docs/EMAIL.md)
- [Web Push](docs/WEB_PUSH.md)
- [Funciones futuras](docs/FUTURE_FEATURES.md)
- [Reglas UX/UI](docs/UX_UI_RULES.md)
- [Auditoría de repositorios de referencia](docs/REFERENCE_REVIEW.md)

## Respuestas

Éxito:

```json
{ "success": true, "data": {} }
```

Error:

```json
{
  "success": false,
  "code": "EXPENSE_NOT_FOUND",
  "message": "No se encontró el gasto."
}
```

Los errores internos, secretos, cookies, SQL y stack traces no se envían en producción.

## Scheduler y servicios opcionales

Con `REMINDER_JOB_ENABLED=false` no se crea ninguna tarea cron. Al activarlo, `REMINDER_JOB_CRON` se valida, el scheduler usa `DEFAULT_TIMEZONE`, evita solapes en el proceso y se detiene durante shutdown. Email, Web Push y Google requieren activar su flag y completar las credenciales correspondientes; consulta [Entorno](docs/ENVIRONMENT.md). El servidor concede 65 segundos al body de una petición (con timeout de cabeceras más estricto) para que una subida válida de 10 MiB no quede por debajo del timeout de 60 segundos del cliente.
