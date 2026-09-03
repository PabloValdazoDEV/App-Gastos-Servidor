# Web Push

Web Push está implementado como canal opcional del centro de notificaciones. Permanece desactivado hasta configurar VAPID y habilitar su feature flag.

Genera un par VAPID con una herramienta mantenida por la librería elegida y guarda:

```env
WEB_PUSH_ENABLED=true
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

Solo `VAPID_PUBLIC_KEY` se replica en `VITE_VAPID_PUBLIC_KEY`. La privada nunca sale del servidor.

Flujo implementado:

1. La pantalla explica la utilidad y muestra “Activar notificaciones”.
2. Solo ese clic registra Service Worker y solicita permiso al navegador.
3. El cliente envía la suscripción autenticada y protegida por CSRF.
4. El backend guarda endpoint, hash del endpoint y claves bajo el usuario.
5. Respuestas 404/410 del push revocan la suscripción.
6. El usuario puede desactivar Push sin perder notificaciones in-app o email.

Nunca se solicita permiso al cargar. Los payloads no deben contener importes o datos financieros sensibles en texto visible de pantalla bloqueada; se prefiere un aviso breve que abra la app autenticada.
