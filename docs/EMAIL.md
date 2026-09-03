# Email

La recuperación de contraseña usa Nodemailer cuando `EMAIL_ENABLED=true`. No se asume Gmail: cualquier proveedor SMTP compatible sirve. Si está desactivado, el endpoint conserva su respuesta genérica pero no envía correo.

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM_NAME=BudgetApp
MAIL_FROM_ADDRESS=no-reply@example.com
```

Usa `SMTP_SECURE=true` para TLS directo si tu proveedor lo requiere, normalmente en 465. Para 587 se suele negociar STARTTLS con `false`; confirma la documentación del proveedor.

Propiedades de la implementación:

- Verificar transporte al arrancar solo cuando email esté activo.
- Plantillas HTML escapan contenido dinámico y siempre tienen versión texto.
- Recuperación responde de forma genérica, aunque el correo no exista.
- No registrar destinatario completo, token, URL sensible ni respuesta SMTP con credenciales.
- Persistir el token de recuperación antes de enviar y esperar la aceptación SMTP.
- Si SMTP falla, registrar únicamente el tipo de error y permitir una nueva solicitud; nunca devolver al navegador si el correo existe.
- Configurar SPF, DKIM y DMARC en el dominio de producción.

Los tokens son aleatorios, de un solo uso, con hash en PostgreSQL y TTL corto. Viajan en el fragmento/pantalla cliente y se remiten al backend en body, no en la ruta API.
