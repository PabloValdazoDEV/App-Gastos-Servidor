# Google OAuth

Google Login está implementado y desactivado por defecto. Usa Authorization Code, OpenID Connect, PKCE, `state` y `nonce`.

## Configuración

1. Crea un proyecto en Google Cloud Console.
2. Configura la pantalla de consentimiento con los datos reales del producto.
3. Crea credenciales OAuth 2.0 de tipo aplicación web.
4. Registra exactamente `GOOGLE_CALLBACK_URL` como URI de redirección autorizado.
5. Copia Client ID y Client Secret solo al `.env` del backend. El cliente no necesita ni usa esas credenciales.
6. Activa `GOOGLE_AUTH_ENABLED=true` y `VITE_ENABLE_GOOGLE_LOGIN=true` cuando las credenciales estén listas.

Desarrollo orientativo:

```env
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
```

En el cliente:

```env
VITE_ENABLE_GOOGLE_LOGIN=true
```

## Desarrollo en ordenador y móvil

Para pruebas solo en el ordenador, `localhost` es válido. La URL actual de red local
`http://192.168.1.103:3000/...` no puede registrarse para Google OAuth: Google exige
HTTPS y no admite direcciones IP sin excepción para aplicaciones web. Para probar el
acceso de Google desde un móvil, publica frontend y backend tras un único dominio HTTPS
que controles (por ejemplo, el dominio de producción) y usa ese mismo dominio en
`SERVER_URL`, `CLIENT_URL`, `CLIENT_ORIGINS` y `GOOGLE_CALLBACK_URL`. Registra la URI
de callback HTTPS exacta en Google Cloud. No actives cookies `SameSite=None` ni rebajes
la seguridad solo para sortear esta restricción.

## Flujo implementado

- El usuario inicia la acción explícitamente.
- Backend genera `state`, nonce y PKCE; el verificador se conserva temporalmente en cookie HttpOnly.
- Para permitir una cuenta nueva, el cliente inicia con `privacyPolicyAcknowledged=true` y la versión publicada. Backend valida esa versión y firma en `state` la confirmación y su propia versión vigente.
- El callback valida `state`, intercambia el code en servidor y verifica firma, issuer, audience, expiración y `email_verified`.
- El login Google termina creando la misma sesión rotatoria en cookies HttpOnly que el login local.
- Un usuario local existente no se enlaza solo porque coincida el email. Si no había una sesión local válida del mismo usuario, `/api/auth/google/link/confirm` exige su contraseña local mediante un desafío temporal HttpOnly de diez minutos.
- La vinculación posterior con `HouseholdPerson` pertenece al flujo de invitaciones; Google no crea personas económicas automáticamente.

Rutas:

```text
GET  /api/auth/google/start?privacyPolicyAcknowledged=true&privacyPolicyVersion=<version>
GET  /api/auth/google/callback
POST /api/auth/google/link/confirm
```

Una cuenta Google ya vinculada también puede usar `/google/start` sin parámetros legales, porque no se produce un alta. Si el callback descubre que tendría que crear usuario, exige la confirmación firmada y vuelve a comprobar que la versión no haya cambiado. La evidencia legal y el resto del alta se confirman en una única transacción.

El callback redirige al cliente a `/auth/callback?status=success`, `/auth/google/link?status=link_required` o `/auth/callback?status=error&error=<code>`. Los errores legales son `PRIVACY_POLICY_ACKNOWLEDGEMENT_REQUIRED`, `PRIVACY_POLICY_NOT_CONFIGURED` y `PRIVACY_POLICY_OUTDATED`; el resto se reduce a `GOOGLE_AUTH_FAILED`. Una configuración o versión inválida detectada antes de salir hacia Google redirige a `/register?privacyError=<code>`. No incluye tokens en la URL.

No envíes `GOOGLE_CLIENT_SECRET` al cliente ni confíes en nombre/email enviados por el navegador.
