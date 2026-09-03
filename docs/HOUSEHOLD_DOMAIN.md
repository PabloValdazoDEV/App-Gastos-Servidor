# Dominio de hogares

Implementación de la Fase 3: hogares, personas económicas, accesos, invitaciones, reparto, categorías y márgenes.

## Integración

El router agregador está montado en `src/app.js` bajo `/api`, después del parser JSON y antes de `notFoundHandler`:

```js
import { createAuthenticate } from './middleware/authenticate.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { createHouseholdDomainRouter } from './modules/household-domain/index.js';

app.use(
  '/api',
  createHouseholdDomainRouter({
    prisma: prismaClient,
    config,
    authenticate: createAuthenticate({ prisma: prismaClient, config }),
    requireCsrf: createCsrfProtection({ config }),
  }),
);
```

La previsualización de una invitación es pública. El router aplica autenticación al resto y exige CSRF en cada operación mutable. La construcción falla si no recibe middleware CSRF.

## Permisos

| Acción | MEMBER | ADMIN | OWNER |
| --- | ---: | ---: | ---: |
| Consultar hogar, personas y categorías | Sí | Sí | Sí |
| Gestionar hogar, personas, reparto y categorías | No | Sí | Sí |
| Consultar y crear invitaciones MEMBER | No | Sí | Sí |
| Gestionar invitaciones ADMIN | No | No | Sí |
| Consultar accesos con datos de usuario | No | Sí | Sí |
| Cambiar o revocar accesos | No | No | Sí |
| Borrar físicamente una categoría sin dependencias | No | No | Sí |
| Archivar el hogar o transferir propiedad | No | No | Sí |

`HouseholdPerson` nunca autoriza. Cada operación carga un `HouseholdUserAccess` activo y cada recurso hijo se busca por `id + householdId`, de modo que un UUID de otro hogar responde como no encontrado.

## Endpoints

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
POST   /api/invitations/preview
POST   /api/invitations/accept
DELETE /api/households/:householdId/invitations/:invitationId

GET    /api/households/:householdId/categories
POST   /api/households/:householdId/categories
PATCH  /api/households/:householdId/categories/:categoryId
POST   /api/households/:householdId/categories/:categoryId/archive
DELETE /api/households/:householdId/categories/:categoryId
```

Crear un hogar añade acceso `OWNER` y las 17 categorías predeterminadas en la misma transacción. Puede recibir personas iniciales; si hay personas activas, el reparto inicial ya debe ser válido.

## Reparto

En modo `PERCENTAGE`, las personas activas y no archivadas suman exactamente `10000` puntos básicos. En modo `FIXED`, cada persona activa necesita `fixedContributionCents >= 0`.

Una persona añadida posteriormente comienza inactiva para no romper un reparto porcentual válido. La operación masiva `PUT /people/distribution` permite activarla y reajustar todas las aportaciones de forma atómica:

```json
{
  "contributionMode": "PERCENTAGE",
  "people": [
    { "personId": "...", "isActive": true, "contributionBps": 6000 },
    { "personId": "...", "isActive": true, "contributionBps": 4000 }
  ]
}
```

Archivar una persona conserva históricos. Se bloquea si todavía tiene gastos personales activos o si el reparto restante no sería válido.

## Invitaciones

- El token opaco se genera con 256 bits aleatorios y PostgreSQL guarda únicamente SHA-256.
- El token se envía en el cuerpo de `POST`, nunca en path ni query.
- La creación devuelve el token una sola vez para construir el enlace o enviarlo por el adaptador de correo. La respuesta usa `Cache-Control: no-store`.
- Un correo dirigido solo puede aceptarlo una cuenta con ese mismo correo normalizado.
- Una invitación asociada a persona vincula esa persona dentro de la misma transacción; una invitación solo por correo no enlaza personas automáticamente.
- La aceptación reclama la invitación, activa o crea el acceso y enlaza la persona de forma serializable.
- Solo una invitación pendiente puede existir por correo o persona y hogar; los índices parciales de PostgreSQL refuerzan la regla.
- `OWNER` no se invita. La propiedad solo cambia mediante `ownership-transfer`, que deja al propietario anterior como `ADMIN`.

## Categorías y margen

El margen general vive en `Household.safetyMarginBps`; una categoría puede heredarlo dejando `safetyMarginBps: null` o sobrescribirlo entre `0` y `10000`.

Las categorías se archivan por defecto. El borrado físico requiere `OWNER` y se rechaza si existen gastos recurrentes, facturas o meses variables asociados.

## Transacciones y auditoría

Las mutaciones que abarcan varias filas usan aislamiento serializable y reintentan conflictos Prisma `P2034` hasta tres veces. Se auditan creación/cambio/archivado de hogar, cambios de personas y reparto, accesos, transferencia, invitaciones y categorías. Los logs no contienen tokens ni correos de invitación.
