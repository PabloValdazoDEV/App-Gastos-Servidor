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
