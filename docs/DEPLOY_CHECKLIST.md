# Lista para subir a producción

Revisa cada punto en orden. La referencia completa de variables está en [ENVIRONMENT.md](ENVIRONMENT.md).

## 1. Antes de tocar nada

- [ ] Copia de seguridad de la base de datos: `pg_dump --format=custom --file=budgetapp-AAAA-MM-DD.dump "$DATABASE_URL"`.
- [ ] Tests en verde en las dos aplicaciones: `npm test` y `npm run lint`.
- [ ] Rama revisada y fusionada en `main` en los dos repositorios.

## 2. Variables del servidor (`.env` de producción)

| Variable | Valor en producción | Por qué |
| --- | --- | --- |
| `NODE_ENV` | `production` | Obligatoria. Sin ella el servidor no arranca: antes arrancaba en modo desarrollo, sin CSRF ni límites de peticiones. |
| `DATABASE_URL` | La base real, con el `?schema=` correcto | Un esquema vacío hace que el login responda «correo o contraseña incorrectos» a todo el mundo. |
| `SERVER_URL` / `CLIENT_URL` | `https://…` con el dominio real | Enlaces de los correos y CORS. |
| `CLIENT_ORIGINS` | Debe incluir `CLIENT_URL` | Si falta, el navegador bloquea las peticiones. |
| `COOKIE_SECURE` | `true` | Obligatorio en producción; requiere HTTPS. |
| `COOKIE_DOMAIN` / `COOKIE_SAME_SITE` | Según el dominio (`lax` si web y API comparten dominio) | `none` exige `COOKIE_SECURE=true`. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CSRF_SECRET` | Nuevos y distintos de los de desarrollo (`openssl rand -base64 64`) | Si se reutilizan, cualquiera con la copia local podría firmar sesiones. |
| `TRUST_PROXY_HOPS` | `1` detrás de un proxy (Nginx, Caddy, Render…) | Con `0` todos los usuarios comparten la IP del proxy y los límites de peticiones se agotan en grupo. |
| `DEFAULT_TIMEZONE` | `Europe/Madrid` | Define qué día es «hoy» para el presupuesto y el calendario. |
| `EMAIL_ENABLED` + `SMTP_*` | Datos del correo real | El servidor verifica la conexión al arrancar. |
| `REMINDER_JOB_ENABLED` / `REMINDER_JOB_CRON` | `true` / `0 8 * * *` | Al arrancar también revisa los avisos pendientes. |
| `PRIVACY_*` | Rellenas | Sin ellas el registro de cuentas nuevas queda bloqueado. |

## 3. Variables del cliente (en el momento de compilar)

| Variable | Valor en producción |
| --- | --- |
| `VITE_API_URL` | `https://<dominio-api>/api` (o `/api` si se sirve bajo el mismo dominio) |
| `VITE_CSRF_COOKIE_NAME` | El mismo valor que `CSRF_COOKIE_NAME` del servidor |

Las variables `VITE_*` son públicas: nunca pongas secretos en ellas.

## 4. Orden de despliegue

1. **Servidor primero**: `npm ci`, `npm run prisma:migrate:deploy` (aplica solo migraciones pendientes; no borra datos), `npm start`.
2. Comprueba `GET /api/health` y que el log muestra `email.transport.verified` y `reminder.scheduler.started`.
3. **Cliente después**: `npm ci`, `npm run build` y publica `dist/`. El cliente nuevo envía campos que un servidor antiguo rechazaría.

## 5. Comprobación final

- [ ] Iniciar sesión con una cuenta real.
- [ ] Inicio muestra «Tu aportación» y «Pagos de hoy y atrasados».
- [ ] Añadir un gasto variable de prueba en un mes con datos y borrarlo después.
- [ ] Cerrar sesión y volver a entrar.
