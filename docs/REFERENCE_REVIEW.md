# Revisión de los repositorios de referencia

## Alcance y versiones revisadas

Esta revisión documenta qué patrones de NotApp se conservarán para que BudgetApp resulte familiar y qué decisiones se rechazan por seguridad, integridad de datos o mantenibilidad.

La auditoría se realizó en modo de solo lectura sobre versiones concretas e inmutables:

- Backend: [`PabloValdazoDEV/NotApp-Servidor` en `a230aeddbe96438a28dfcc92a73f797f43d804ec`](https://github.com/PabloValdazoDEV/NotApp-Servidor/tree/a230aeddbe96438a28dfcc92a73f797f43d804ec).
- Frontend: [`PabloValdazoDEV/NotApp-Cliente` en `16d8eb7ade14df98a26461dc82694df75fcb3d6b`](https://github.com/PabloValdazoDEV/NotApp-Cliente/tree/16d8eb7ade14df98a26461dc82694df75fcb3d6b).

Se revisaron específicamente estructura, Prisma, autenticación, Axios, TanStack React Query, hogares y miembros, permisos, recuperación de contraseña, Nodemailer y CORS.

## Patrones que se mantienen

### Organización por dominio

NotApp agrupa las rutas backend por recurso y refleja esa división en módulos API del cliente. Es una estructura fácil de recorrer y mantiene cerca el código relacionado ([router backend](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/index.js#L1-L18), [API frontend](https://github.com/PabloValdazoDEV/NotApp-Cliente/tree/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/api)).

BudgetApp conservará esa orientación por dominio, pero cada módulo backend separará rutas, validación, controlador, servicio y acceso a datos. Esto evita que la mayor complejidad financiera termine concentrada en routers extensos.

### Prisma y operaciones atómicas

Se mantienen los siguientes patrones:

- UUID como identificadores públicos.
- Enums para estados y roles cerrados.
- Relaciones explícitas con políticas de borrado deliberadas.
- Restricciones únicas compuestas para impedir duplicados.
- Consultas con `select` limitado.
- Transacciones para cambios relacionados.
- Posibilidad de pasar el cliente transaccional a servicios y helpers.

NotApp ya aplica correctamente restricciones compuestas en favoritos y menús ([favoritos](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/prisma/schema.prisma#L148-L157), [menús](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/prisma/schema.prisma#L204-L230)) y usa transacciones en operaciones como la transferencia de propietario ([home.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/home.js#L435-L504)).

### Autorización vinculada al recurso

El patrón más valioso del backend de referencia es consultar un recurso dentro del ámbito del hogar y de la membresía autenticada. `getAccessibleHome`, `getAccessibleList` y sus variantes reducen el riesgo de IDOR y aceptan un cliente transaccional ([permissions.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/utils/permissions.js#L21-L125)).

BudgetApp mantendrá esta idea mediante políticas de autorización centralizadas. Una ruta no podrá cargar primero una entidad por ID y comprobar el hogar después; la consulta deberá estar acotada desde el principio por usuario, hogar y acción permitida.

### Cliente HTTP y datos remotos

Se conserva una única instancia Axios con URL base, timeout y normalización común de errores ([config.js](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/api/config.js#L1-L52)). También se mantienen módulos API por dominio y React Query como propietario del estado remoto.

El favorito de hogar muestra un patrón correcto de actualización optimista: cancela la consulta, guarda el valor anterior, actualiza la caché, restaura en error e invalida la clave precisa al finalizar ([Home.jsx](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/pages/Home.jsx#L38-L77)). Este será el modelo para las pocas operaciones financieras en las que una actualización optimista sea segura.

### Rutas y arranque de sesión

Se mantiene la separación de rutas públicas y privadas, el `Layout` compartido y el estado de carga durante la comprobación inicial de sesión ([App.jsx](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/App.jsx#L31-L82)). La protección visual del frontend seguirá siendo solo una mejora de experiencia; la autorización real siempre se decidirá en el backend.

### Email transaccional

Se mantiene la configuración SMTP por variables de entorno y una plantilla común. La plantilla actual escapa los valores dinámicos y usa adjuntos CID, dos decisiones correctas ([nodemailer.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/config/nodemailer.js#L1-L16), [emailTemplate.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/config/emailTemplate.js#L7-L21)).

### CORS mediante allowlist

NotApp usa una lista exacta de orígenes y reutiliza la configuración en Express y Socket.IO ([corsConfig.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/config/corsConfig.js#L1-L26), [app.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/app.js#L15-L24)). BudgetApp mantendrá una allowlist explícita y nunca combinará `credentials: true` con un origen comodín.

## Decisiones rechazadas

### JWT accesible desde JavaScript

El backend devuelve JWT de 30 días y el cliente lo guarda mediante `js-cookie`. La cookie no puede ser HttpOnly, queda expuesta ante XSS y el logout solo elimina la copia local ([auth backend](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/auth.js#L215-L235), [auth frontend](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/api/auth.js#L4-L47)).

BudgetApp no guardará credenciales de sesión en `localStorage`, Jotai ni cookies legibles por JavaScript.

### Bypass genérico con API key

El middleware permite continuar si `x-api-key` coincide con `VITE_API_KEY`, sin establecer identidad en `req.user` ([auth.middleware.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/middleware/auth.middleware.js#L3-L21)). Este bypass no se copiará. Una variable con prefijo `VITE_` nunca se tratará como secreto.

Si en el futuro existe comunicación máquina a máquina, tendrá autenticación separada, credenciales rotables, alcance limitado y endpoints específicos.

### Enumeración y bloqueo de cuentas

El login revela si un correo está registrado, recorta la contraseña y permite provocar un bloqueo temporal contra una cuenta conocida ([auth.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/auth.js#L163-L226)). BudgetApp usará mensajes genéricos, normalización consistente del correo y límites combinados por IP y cuenta. Las contraseñas nunca se modificarán con `trim()`.

### Recuperación de contraseña no atómica

El flujo de referencia:

- devuelve `404` para correos inexistentes;
- carece de rate limit específico;
- guarda el token completo;
- coloca el token en rutas que pueden registrarse en logs;
- no comprueba un token nulo antes de acceder a sus propiedades;
- no verifica el propósito en el endpoint de cambio;
- marca el token como usado antes de actualizar la contraseña;
- no agrupa consumo y cambio en una transacción;
- no revoca sesiones existentes;
- confirma el envío antes de conocer el resultado SMTP.

El flujo puede revisarse en [router/auth.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/auth.js#L267-L409) y el almacenamiento en claro en [OneTimeToken](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/prisma/schema.prisma#L248-L257).

Ninguna de estas decisiones se trasladará a BudgetApp.

### Persona del hogar acoplada a usuario

En NotApp, `Member.user_id` es obligatorio y se borra en cascada con el usuario ([schema.prisma](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/prisma/schema.prisma#L98-L105)). Esto no satisface el requisito de gestionar personas sin cuenta y tampoco preserva bien el historial financiero.

BudgetApp separará al participante económico del usuario que accede a la aplicación.

### Integridad insuficiente de membresías y roles

`Member` no tiene unicidad compuesta por usuario y hogar. Además, varias altas comprueban `count` y luego ejecutan `create` fuera de una operación atómica, por lo que dos solicitudes concurrentes pueden crear duplicados o superar límites ([unión pública](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/member.js#L277-L324), [aceptación](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/member.js#L383-L410)).

Un administrador también puede borrar al propietario o convertir cualquier miembro en propietario porque ambos endpoints aceptan `OWNER` y `ADMIN` sin aplicar jerarquía ([member.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/member.js#L677-L763)). BudgetApp hará cumplir la jerarquía en el servidor y preservará la invariante de un único propietario.

### Invitaciones no revocables

Las invitaciones públicas usan JWT de 30 días sin registro persistente de revocación ([member.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/member.js#L232-L269)). BudgetApp usará registros de invitación con estado, caducidad, revocación y hash de token.

NotApp contiene un patrón parcialmente aprovechable para enlaces públicos: token aleatorio, SHA-256 y `revokedAt`. Sin embargo, también conserva el token en claro, lo que anula parte de la protección ([menu.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/router/menu.js#L340-L384)). BudgetApp persistirá solo el hash y mostrará el token original una única vez.

### Tipos financieros inadecuados

NotApp guarda `Item.price` como `String` ([schema.prisma](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/prisma/schema.prisma#L188-L202)). BudgetApp no utilizará `String` ni `Float` para dinero. En el alcance doméstico, los importes se almacenan como enteros en céntimos y los porcentajes como puntos básicos; así no hay errores binarios ni serialización especial.

### `db push` sin historial de migraciones

El backend de referencia expone `prisma db push` como flujo de base de datos y no contiene migraciones versionadas ([package.json](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/package.json#L6-L11)). BudgetApp usará `prisma migrate dev` en desarrollo y `prisma migrate deploy` en despliegue.

### Errores API tratados como éxitos

Las funciones API del cliente suelen capturar errores y devolver `{ success: false }`; React Query considera la promesa resuelta y no ejecuta `onError` ([home.js](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/api/home.js#L7-L42)). BudgetApp dejará que Axios rechace con un `ApiError` normalizado.

### Invalidaciones globales y claves incompletas

Hay invalidaciones sin `queryKey` que recargan toda la caché, por ejemplo en miembros ([HogarMembers.jsx](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/pages/HogarMembers.jsx#L84-L119)). También se usa `useMutation` para lecturas filtradas y una consulta omite filtros y página de su clave ([ListAdd.jsx](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/pages/ListAdd.jsx#L56-L85)).

BudgetApp tendrá factories de claves; todo parámetro que cambie el resultado pertenecerá a la clave. Las invalidaciones serán específicas y una lectura nunca se modelará como mutación.

### Instancia Axios duplicada

`useApi` crea otra instancia e importa un `tokenAtom` inexistente ([useApi.js](https://github.com/PabloValdazoDEV/NotApp-Cliente/blob/16d8eb7ade14df98a26461dc82694df75fcb3d6b/src/hooks/useApi.js#L1-L22)). BudgetApp tendrá exactamente un cliente HTTP compartido.

### Ausencia de endurecimiento y tests

El servidor de referencia no instala Helmet ni rate limiting en su arranque, y el script de tests es un placeholder ([app.js](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/app.js#L20-L36), [package.json](https://github.com/PabloValdazoDEV/NotApp-Servidor/blob/a230aeddbe96438a28dfcc92a73f797f43d804ec/package.json#L6-L11)). BudgetApp incorporará seguridad y pruebas desde la base, no como trabajo posterior.

## Decisiones resultantes para BudgetApp

Las siguientes decisiones son vinculantes para la implementación.

### 1. Estructura backend

Cada dominio vivirá bajo `src/modules/<domain>/` con, como mínimo:

```text
<domain>.routes.js
<domain>.controller.js
<domain>.service.js
<domain>.schema.js
```

La configuración compartida se ubicará en `src/config/`, los middlewares en `src/middleware/`, Prisma en `src/lib/prisma.js` y los jobs en `src/jobs/`. Los controladores traducirán HTTP; las reglas financieras y de autorización vivirán en servicios puros y comprobables.

### 2. Modelo de personas y acceso

- `HouseholdPerson` representará a quien participa en reparto, gastos y aportaciones.
- `HouseholdPerson.linkedUserId` es opcional y enlaza una persona económica con una cuenta.
- `HouseholdUserAccess` representa el acceso de una cuenta registrada y su rol.
- Una membresía podrá vincularse opcionalmente a una persona, pero ambos conceptos no serán intercambiables.
- Borrar una cuenta desvinculará al usuario y conservará personas, movimientos, facturas, aportaciones y auditoría histórica.

### 3. Permisos

- Toda operación se autorizará en backend mediante políticas por acción.
- Solo `OWNER` podrá transferir propiedad, archivar el hogar y modificar roles elevados.
- `ADMIN` no podrá editar ni eliminar al propietario.
- Existirá exactamente un propietario activo por hogar.
- Las operaciones de transferencia y salida se ejecutarán en transacción.
- Las consultas estarán acotadas por hogar para evitar acceso cruzado entre tenants.
- Los IDs de usuario se derivarán de la sesión; no se confiará en `user_id` enviado por el cliente.

### 4. Prisma y dinero

- Se usarán migraciones versionadas y revisables.
- Dinero: `Int` en céntimos; nunca `Float` o texto. El límite operativo está documentado antes de migrar a `BigInt`.
- Porcentajes: `Int` en puntos básicos (`10000 = 100 %`) para repartos reproducibles.
- Fechas periódicas y simulaciones tendrán zona y semántica documentadas.
- Todas las claves foráneas consultadas habitualmente tendrán índice.
- Se añadirán restricciones únicas para membresías, invitaciones activas, presupuestos mensuales y demás invariantes del dominio.
- Los cálculos usan aritmética entera/racional, una política única de redondeo al céntimo y reparto por mayor resto.

### 5. Sesión local y Google OAuth

- Login local y Google OAuth terminarán en el mismo servicio de emisión de sesión.
- El access token JWT será corto y viajará en cookie `HttpOnly`, `Secure` en producción y `SameSite=Lax`.
- El refresh token será aleatorio y rotatorio; se almacenará únicamente su hash en una tabla de sesiones.
- Logout revocará la sesión persistida y borrará ambas cookies.
- No habrá tokens de autenticación accesibles desde JavaScript.
- Los endpoints mutables comprobarán origen y token CSRF conforme a la configuración final de dominios.
- Los límites de login combinarán IP y cuenta y devolverán mensajes genéricos.

### 6. Recuperación de contraseña

- `POST /auth/forgot-password` devolverá siempre una respuesta genérica.
- Se aplicará rate limit específico por IP y email normalizado.
- El token será opaco, criptográficamente aleatorio y de vida corta.
- Solo se almacenará SHA-256 del token junto a `purpose`, `expiresAt` y `usedAt`.
- El token llegará al endpoint de cambio dentro del cuerpo del `POST`, no en la ruta.
- Validación, consumo condicional, cambio de hash y revocación de sesiones se realizarán en una única transacción.
- Una reutilización o carrera devolverá el mismo error genérico de token inválido.

### 7. Nodemailer y trabajos

- Nodemailer quedará detrás de un servicio de email; los controladores no llamarán directamente al transporter.
- `MAIL_FROM` será obligatorio y corresponderá a un remitente verificado.
- Cada correo tendrá HTML escapado y alternativa de texto plano.
- Solicitar un correo persistirá un trabajo/outbox; un worker desacoplado se encargará del envío y los reintentos.
- La respuesta HTTP confirmará que la solicitud fue aceptada, no que el proveedor SMTP entregó el mensaje.
- Tokens y secretos nunca aparecerán en logs.

### 8. CORS, cookies y CSRF

- La variable backend será `CLIENT_ORIGINS`, no `VITE_API_URL`.
- Se analizará con `split`, `trim` y filtrado de valores vacíos.
- Solo se permitirán orígenes configurados explícitamente.
- `credentials: true` se habilitará tanto en backend como en Axios.
- CORS nunca se considerará autenticación.
- Las peticiones sin `Origin` podrán aceptarse cuando proceda, pero seguirán necesitando autenticación y autorización normales.
- Se verificará `Origin` en métodos mutables y se añadirá protección CSRF compatible con la sesión por cookies.

### 9. Axios y React Query

- Habrá una única instancia Axios con `baseURL`, `timeout`, `withCredentials: true` y errores normalizados.
- Axios no leerá ni enviará manualmente el JWT.
- Las funciones API devolverán datos en éxito y lanzarán `ApiError` en fallo.
- Las claves React Query se crearán mediante factories por dominio.
- Toda clave incluirá hogar y parámetros que modifiquen el resultado.
- Las invalidaciones serán específicas.
- React Query poseerá el estado remoto; Jotai se reservará para estado global puramente cliente cuando sea necesario.
- La fecha de simulación formará parte de las consultas de posición, déficit y próximos pagos, pero no alterará la clave ni el cálculo del presupuesto mensual estándar si los datos presupuestarios no cambian.

### 10. Seguridad operativa y pruebas

- Zod validará `body`, `params`, `query` y configuración de entorno.
- Helmet, límites de body, rate limiting y un manejador central de errores estarán activos desde el primer hito.
- Cualquier upload tendrá límites de tamaño y MIME, nombre no confiable, limpieza garantizada y nunca se versionará.
- Los logs serán estructurados y excluirán contraseñas, cookies, tokens y datos financieros sensibles.
- Backend: tests unitarios de cálculo y permisos, integración HTTP/Prisma y casos de concurrencia.
- Frontend: tests de formularios y estados de consulta; E2E para login, hogares, presupuestos, recuperación y permisos.
- Habrá una prueba explícita que demuestre que cambiar solo la fecha de simulación no modifica el presupuesto mensual estándar.

## Resumen

La familiaridad con NotApp se conserva en la organización por dominios, Prisma, los helpers de acceso, las transacciones, Axios centralizado, React Query, rutas privadas y plantillas de email. Se rechazan el JWT accesible por JavaScript, el bypass por API key, la recuperación no atómica, el acoplamiento persona-usuario, los permisos sin jerarquía, los tokens en claro, los importes como texto, `db push`, los errores resueltos como éxito y las invalidaciones globales.

Esta revisión debe consultarse antes de introducir cambios en autenticación, hogares, miembros, permisos, recuperación de cuenta, correo, CORS o arquitectura de datos remotos.
