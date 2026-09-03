# Variables de entorno

`.env.example` es el inventario canónico. Toda variable nueva se documenta allí antes de usarse. `.env` nunca se versiona.

## Aplicación y red

| Variable | Obligatoria | Secreta | Uso |
|---|---:|---:|---|
| `NODE_ENV` | Sí | No | `development`, `test` o `production`. |
| `PORT` | Sí | No | Puerto HTTP, por defecto `3000`. |
| `APP_NAME` | Sí | No | Nombre de servicio y remitente por defecto. |
| `SERVER_URL` | Sí | No | Origen público del backend. |
| `CLIENT_URL` | Sí | No | Origen principal del cliente. |
| `CLIENT_ORIGINS` | Sí | No | Allowlist exacta separada por comas; debe incluir `CLIENT_URL`. |
| `DATABASE_URL` | Sí | Sí | Conexión PostgreSQL usada por Prisma. |

No uses comodín CORS con cookies. En producción, limita `CLIENT_ORIGINS` a orígenes HTTPS conocidos.

## Sesión y CSRF

| Variable | Obligatoria | Secreta | Uso |
|---|---:|---:|---|
| `JWT_ACCESS_SECRET` | Sí | Sí | Firma access JWT. Mínimo 32 caracteres. |
| `JWT_REFRESH_SECRET` | Sí | Sí | Firma refresh JWT rotatorio. Mínimo 32 caracteres. |
| `JWT_ACCESS_TTL` | Sí | No | Duración corta, por defecto `15m`. |
| `JWT_REFRESH_TTL_DAYS` | Sí | No | Caducidad máxima de sesión. |
| `AUTH_COOKIE_NAME` | Sí | No | Cookie HttpOnly del access token. |
| `REFRESH_COOKIE_NAME` | Sí | No | Cookie HttpOnly del refresh token. |
| `COOKIE_DOMAIN` | No | No | Dominio compartido, vacío en localhost. |
| `COOKIE_SECURE` | Sí | No | Debe ser `true` con HTTPS. |
| `COOKIE_SAME_SITE` | Sí | No | `lax`, `strict` o `none`; `none` exige `Secure`. |
| `CSRF_SECRET` | Sí | Sí | Firma de token CSRF. Mínimo 32 caracteres. |
| `CSRF_COOKIE_NAME` | Sí | No | Nombre del token double-submit. |
| `BCRYPT_ROUNDS` | Sí | No | Coste bcrypt, rango validado `8..15`. |

Genera tres secretos distintos:

```bash
openssl rand -base64 64
```

Los tres secretos y los tres nombres de cookie deben ser diferentes. En producción, `COOKIE_SECURE=true` es obligatorio. El refresh contiene identificadores de sesión/familia y un `jti` aleatorio; la base guarda SHA-256 del token completo y rota cada uso. Los JWT nunca se entregan a JavaScript.

## Metadatos de privacidad y alta

| Variable | Obligatoria para arrancar | Pública | Uso |
|---|---:|---:|---|
| `PRIVACY_POLICY_VERSION` | No | Sí | Identificador estable de la versión vigente, máximo 120 caracteres. |
| `PRIVACY_POLICY_EFFECTIVE_DATE` | No | Sí | Fecha de vigencia civil en `YYYY-MM-DD`. |
| `PRIVACY_CONTROLLER_NAME` | No | Sí | Nombre del responsable del tratamiento. |
| `PRIVACY_CONTROLLER_CONTACT_EMAIL` | No | Sí | Contacto válido del responsable. |
| `PRIVACY_CONTROLLER_ADDRESS` | No | Sí | Dirección del responsable, si procede. |
| `PRIVACY_DPO_EMAIL` | No | Sí | Contacto del DPO, si existe. |

Estas variables no son secretos. El proceso arranca aunque falten, y `GET /api/legal/privacy-policy` informa `configured: false`; sin embargo, las altas local y Google fallan de forma cerrada hasta completar versión, fecha, nombre y correo de contacto. Dirección y DPO son opcionales. Una fecha o correo presentes pero inválidos sí impiden arrancar para evitar publicar metadatos mal formados.

`PRIVACY_POLICY_VERSION` debe cambiar cada vez que cambie el texto o la finalidad informada. Despliega texto y versión de forma coordinada, archiva una copia inalterable de cada versión publicada y nunca reutilices el mismo identificador para textos distintos. Antes de producción revisa que el documento describa los proveedores y plazos de conservación reales del despliegue; el backend no los infiere ni promete automáticamente.

Los documentos opcionales de factura no añaden variables de entorno: sus límites son fijos (5 por factura y 10 MiB por archivo) y se almacenan como `BYTEA` en PostgreSQL. Antes de habilitarlos con datos reales, la política publicada debe describir de forma fiel el almacenamiento, acceso por miembros del hogar, supresión y retención de backups y cualquier proveedor o escáner externo. Si esto cambia el texto o las finalidades informadas, publica una versión nueva de la política de forma coordinada.

## Servicios opcionales

| Variable | Obligatoria | Secreta | Uso |
|---|---:|---:|---|
| `GOOGLE_AUTH_ENABLED` | Sí | No | Activa Google OAuth. |
| `GOOGLE_CLIENT_ID` | Condicional | No | Identificador OAuth. |
| `GOOGLE_CLIENT_SECRET` | Condicional | Sí | Secreto OAuth solo backend. |
| `GOOGLE_CALLBACK_URL` | Condicional | No | Callback exacto registrado. |
| `EMAIL_ENABLED` | Sí | No | Activa SMTP. |
| `SMTP_HOST` | Condicional | No | Host SMTP. |
| `SMTP_PORT` | Condicional | No | Puerto SMTP. |
| `SMTP_SECURE` | Condicional | No | TLS directo, habitual en 465. |
| `SMTP_USER` | Condicional | Sí | Usuario SMTP. |
| `SMTP_PASS` | Condicional | Sí | Contraseña SMTP. |
| `MAIL_FROM_NAME` | Condicional | No | Nombre del remitente. |
| `MAIL_FROM_ADDRESS` | Condicional | No | Dirección verificada. |
| `WEB_PUSH_ENABLED` | Sí | No | Activa Web Push. |
| `VAPID_PUBLIC_KEY` | Condicional | No | Clave pública entregable al cliente. |
| `VAPID_PRIVATE_KEY` | Condicional | Sí | Clave privada solo backend. |
| `VAPID_SUBJECT` | Condicional | No | Contacto `mailto:` o URL HTTPS. |

“Condicional” significa obligatoria cuando su flag vale `true`. Con flags `false`, el resto de la aplicación sigue funcionando.

## Jobs y seguridad operativa

| Variable | Obligatoria | Secreta | Uso |
|---|---:|---:|---|
| `REMINDER_JOB_ENABLED` | Sí | No | Permite ejecutar recordatorios. |
| `REMINDER_JOB_CRON` | Sí | No | Expresión orientativa para scheduler. El job no depende de ella. |
| `CRON_SECRET` | No | Sí | Protege un disparador HTTP futuro; no es necesario al ejecutar CLI. |
| `RATE_LIMIT_WINDOW_MS` | Sí | No | Ventana general. |
| `RATE_LIMIT_MAX` | Sí | No | Máximo general por ventana. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | Sí | No | Ventana específica de auth. |
| `AUTH_RATE_LIMIT_MAX` | Sí | No | Máximo estricto de auth. |
| `TRUST_PROXY_HOPS` | Sí | No | Saltos de reverse proxy confiables; `0` si Express recibe tráfico directo. |
| `PASSWORD_RESET_TTL_MINUTES` | Sí | No | TTL de recuperación. |
| `INVITATION_TTL_DAYS` | Sí | No | TTL de invitaciones. |
| `LOG_LEVEL` | Sí | No | `fatal`, `error`, `warn`, `info`, `debug` o `silent`. |

Los limitadores general, de auth por IP y de auth por cuenta usan memoria del proceso. En un despliegue con varias instancias deben usar un store compartido compatible, manteniendo la misma política. Configura `TRUST_PROXY_HOPS` según la topología real; un valor excesivo permite falsificar IPs y uno insuficiente agrupa clientes detrás del proxy.

## Defaults del producto

| Variable | Obligatoria | Secreta | Uso |
|---|---:|---:|---|
| `DEFAULT_TIMEZONE` | Sí | No | Zona IANA inicial. |
| `DEFAULT_LOCALE` | Sí | No | Locale inicial. |
| `DEFAULT_CURRENCY` | Sí | No | Código ISO de tres letras. |
| `DEFAULT_SAFETY_MARGIN_PERCENT` | Sí | No | Margen inicial, `10`. |
| `DEFAULT_CONTRIBUTION_DAY` | Sí | No | Día habitual inicial. |

## Ejemplo local

Parte de `.env.example`, sustituye únicamente valores locales y secretos. No copies una URL o secreto de producción a desarrollo. Para validar sin iniciar:

```bash
npm run prisma:validate
node --input-type=module -e "import('dotenv/config').then(() => import('./src/config/env.js')).then(({ loadEnv }) => loadEnv())"
```
