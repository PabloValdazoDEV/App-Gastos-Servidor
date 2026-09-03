# Invariantes de base de datos

Prisma expresa relaciones, claves e índices comunes en `prisma/schema.prisma`. La migración inicial añade las reglas que Prisma 6 no puede representar y las ampliaciones posteriores conservan su propia migración versionada. No se deben sustituir por `prisma db push`.

## Checks de dominio

- Todos los importes de entrada son no negativos; los gastos y facturas deben ser mayores que cero.
- Los puntos básicos están entre `0` y `10000`.
- `Household.contributionDay` está entre `1` y `31`.
- `VariableExpenseMonth.month` está entre `1` y `12` y el año usa un rango operativo razonable.
- `UtilityInvoice.periodEnd >= periodStart`.
- `RecurringExpense.endDate` es nulo o no anterior a `startDate`.
- `CUSTOM_MONTHS` exige `intervalMonths >= 1`; el resto de frecuencias exige `intervalMonths IS NULL`.
- `PERSONAL` exige `personalPersonId`; `HOUSEHOLD` exige que sea nulo.
- `PAID` exige importe real y fecha; `SKIPPED` no debe fingir un pago real.
- Elegir “usar importe real” exige un pago real y copia exactamente ese importe al siguiente ciclo.
- `SUMMARY` exige `summaryAmountCents`; `DETAIL` exige que sea nulo.
- Los offsets de recordatorio están entre `0` y `365`.
- El total recomendado de una contribución es exactamente estándar + personal + ajuste temporal.
- `InvoiceDocument.sizeBytes` está entre 1 y 10 MiB, coincide con `octet_length(content)` y el MIME persistido pertenece a PDF/JPEG/PNG/WebP.

Extractos representativos de la migración:

```sql
ALTER TABLE "RecurringExpense"
ADD CONSTRAINT "recurring_expense_scope_check" CHECK (
  ("scope" = 'HOUSEHOLD' AND "personalPersonId" IS NULL)
  OR
  ("scope" = 'PERSONAL' AND "personalPersonId" IS NOT NULL)
);

ALTER TABLE "RecurringExpense"
ADD CONSTRAINT "recurring_expense_interval_check" CHECK (
  ("frequency" = 'CUSTOM_MONTHS' AND "intervalMonths" >= 1)
  OR
  ("frequency" <> 'CUSTOM_MONTHS' AND "intervalMonths" IS NULL)
);

ALTER TABLE "VariableExpenseMonth"
ADD CONSTRAINT "variable_expense_mode_check" CHECK (
  ("entryMode" = 'SUMMARY' AND "summaryAmountCents" IS NOT NULL)
  OR
  ("entryMode" = 'DETAIL' AND "summaryAmountCents" IS NULL)
);
```

## Exclusión resumen/detalle

La fila `VariableExpenseMonth` es el único bloque canónico para hogar, categoría, propietario y mes. La migración incluye dos triggers:

1. Rechazar altas o cambios de `VariableExpenseEntry` si el padre no está en modo `DETAIL`, o si `spentOn` no pertenece al año/mes del padre.
2. Rechazar el cambio a `SUMMARY` mientras existan entradas detalle.

El endpoint de cambio de modo debe pedir confirmación explícita antes de eliminar entradas existentes. El trigger es la última defensa contra carreras o errores de código.

El trigger de entradas bloquea la fila padre con `FOR UPDATE`. Así, una inserción concurrente y un cambio a `SUMMARY` no pueden confirmarse a la vez.

## Unicidad parcial

PostgreSQL debe garantizar un solo plan de recuperación activo por hogar:

```sql
CREATE UNIQUE INDEX "recovery_plan_one_active_uq"
ON "RecoveryPlan" ("householdId")
WHERE "status" = 'ACTIVE';
```

Las invitaciones pendientes se controlan transaccionalmente y además necesitan índices únicos parciales. PostgreSQL permite varias invitaciones históricas, pero solo una pendiente para el mismo destino:

```sql
CREATE UNIQUE INDEX "invitation_pending_email_uq"
ON "Invitation" ("householdId", "email")
WHERE "status" = 'PENDING' AND "email" IS NOT NULL;

CREATE UNIQUE INDEX "invitation_pending_person_uq"
ON "Invitation" ("householdId", "householdPersonId")
WHERE "status" = 'PENDING' AND "householdPersonId" IS NOT NULL;
```

## Reglas transaccionales

Estas reglas abarcan varias filas y permanecen en servicios de dominio, siempre dentro de transacciones:

- Los participantes porcentuales activos suman exactamente `10000` puntos básicos.
- Persona, categoría, gasto, invitación y planificación pertenecen al mismo hogar.
- `Household.ownerUserId` conserva un propietario y su acceso `OWNER` correspondiente.
- Solo el propietario transfiere propiedad; un administrador no modifica ni elimina al propietario.
- Preparar mes, aceptar invitación, rotar sesión y registrar pago son atómicos.
- Registrar un pago actualiza el siguiente vencimiento y, solo con confirmación, el siguiente importe.
- El máximo de 5 documentos por factura se comprueba mediante `count + create` en transacción serializable; los conflictos concurrentes se reintentan de forma acotada.
- Los conflictos serializables de Prisma (`P2034`) se reintentan un número pequeño y acotado.

## Conservación e idempotencia

- `LegalDocumentAcceptance` es append-only desde la aplicación: no existe endpoint de modificación o borrado y su clave única impide duplicar usuario + tipo + versión. No guarda IP. La FK usa `ON DELETE CASCADE` para que una futura supresión real del usuario pueda incluir esta evidencia; conservarla después del cierre requeriría definir previamente base jurídica, plazo y un proceso específico, y no se presupone una retención indefinida.
- `InvoiceDocument` conserva el binario en PostgreSQL junto a la factura. Borrar el documento o la factura elimina el `BYTEA` mediante la operación explícita o `ON DELETE CASCADE`; no existe caducidad automática. El uploader pasa a `NULL` si se suprime ese usuario. Backups y réplicas obedecen la retención de infraestructura, que debe reflejarse en la política desplegada.
- Subir y borrar documentos crea auditoría `EXPENSE_CHANGED` con operación, factura e identificador del documento. Nunca copia contenido ni nombre de archivo al audit log.
- Las relaciones financieras desde el hogar usan `RESTRICT`; un borrado accidental no arrastra personas, categorías, gastos, facturas, históricos o planificaciones.
- Los recursos con `isActive` o `archivedAt` se archivan por defecto. Un borrado físico solo se permite cuando el producto lo exponga expresamente y no existan dependencias.
- `Notification` identifica de forma única usuario + gasto + vencimiento + offset. `NotificationDelivery` añade el canal con `UNIQUE(notificationId, channel)`, sin duplicar esos cuatro campos derivables.
- El job reclama entregas mediante `PENDING -> PROCESSING`, `lockedAt` y `lockedBy`; el claim es un `UPDATE ... RETURNING` atómico. Después marca `SENT`, `FAILED` o devuelve la fila a `PENDING` con `nextAttemptAt`.
- PostgreSQL evita filas duplicadas, pero no puede ofrecer exactamente-una-vez junto con SMTP/Web Push. Los adaptadores usan un identificador estable, reintentos acotados y no vuelven a reclamar `SENT`.

## Límite de `Int`

Prisma `Int` corresponde a entero PostgreSQL de 32 bits: hasta 2.147.483.647 céntimos (aprox. 21,47 millones de euros por campo). Es suficiente para un presupuesto doméstico. Si cambia el alcance, la migración a `BigInt` debe ser explícita e incluir su serialización JSON; no se cambia preventivamente.

## Proceso seguro de migración

1. Configurar una base de desarrollo desechable, nunca producción.
2. Ejecutar `npx prisma migrate dev --create-only --name init`.
3. Revisar el SQL generado.
4. Añadir checks, triggers e índices parciales de este documento.
5. Ejecutar `npx prisma migrate dev` solo si no solicita reset destructivo.
6. Validar y probar la migración desde una base vacía.
7. Usar `npx prisma migrate deploy` en despliegues.

Si Prisma propone reset, pérdida de columnas o eliminación de tablas, se detiene el proceso y se solicita confirmación. Nunca se automatiza `migrate reset`, `DROP DATABASE` ni `DROP TABLE`.
