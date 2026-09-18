# Alta de compras desde un archivo

## Contrato

Ruta base autenticada: `/api/households/:householdId/purchase-drafts`.

- `GET /`: borradores propios no confirmados y no caducados, solo metadatos.
- `POST /`: bytes PDF/JPEG/PNG/WebP, `Content-Type` y `X-Document-Filename` codificado con `encodeURIComponent`; máximo 10 MiB y firma validada. Exige CSRF y pertenencia al hogar antes de consumir bytes.
- `GET /:draftId`: metadatos e historial de análisis, solo para quien subió el archivo.
- `DELETE /:draftId`: eliminación explícita de un borrador sin confirmar, con CSRF.
- `POST /:draftId/analyze`, `{consent:true}`: extracción revisable. Comparte proveedor y límite por usuario con los análisis de documentos guardados; no hay reintento automático de llamadas al proveedor.
- `POST /:draftId/confirm`, `{purchase,analysisId:null|uuid,currency}`: un solo producto, datos revisados con el contrato de creación existente. Guarda compra, producto, pago/plan, bytes originales e historial de análisis en una transacción Serializable. Un fallo de almacenamiento revierte todo.

La confirmación repetida con el mismo cuerpo devuelve la compra existente. Un cuerpo diferente produce 409; nunca duplica la compra de ese borrador. La visibilidad se vuelve a comprobar. Los archivos y análisis no salen en logs de errores.

## Persistencia y compatibilidad

`PurchaseDraft` y `PurchaseDraftAnalysis` son privados del usuario dentro del hogar. Los borradores caducan a las 24 horas y quedan inaccesibles. La subida siguiente del mismo usuario/hogar elimina sus borradores caducados sin confirmar; no hay purga programada global. Máximo 20 activos por usuario/hogar. Al confirmar, los bytes se trasladan a `PurchaseDocumentContent` y se vacían en el borrador; se conserva el identificador de confirmación para reintentos.

Las nuevas altas de la interfaz envían `singleProduct:true`; las confirmaciones de borradores lo imponen. No admiten añadir más productos, ni mediante análisis posteriores. Su precio se sincroniza con el total al editar, sin reescribir pagos reales. Las compras históricas conservan su estructura y los clientes anteriores pueden seguir usando el contrato multiproducto omitiendo la marca.

Migraciones aditivas: `20260918120000_add_purchase_intake` y `20260918121000_single_product_purchase`. Usar `prisma migrate deploy` y `prisma generate`; nunca `migrate reset` para instalar esta función.

## Un único origen financiero

Puntuales muestra el pago único y la entrada de financiación. Recurrentes muestra el plan finito y permite registrar sus cuotas con los endpoints de compras existentes. Son vistas vinculadas, **no copias en OneTimeExpense o RecurringExpense**. Presupuesto, calendario, previsión y planificación siguen usando `purchaseFinancialSources`, con margen cero. No hay doble cómputo ni cambios automáticos de saldos. Las cuotas futuras siguen pendientes; el último vencimiento y su redondeo proceden del plan real.

## Verificación

Las integraciones de `purchaseAnalysis.integration.test.js` cubren acceso privado, CSRF, consentimiento, firmas, historial, moneda, edición, expiración, reintento idempotente, fallo atómico de almacenamiento, financiación finita, un producto y límite compartido. Se ejecutan con `PURCHASE_ANALYSIS_DB_TEST=1` contra PostgreSQL local con rollback; no llaman a OpenAI.

Se conserva la configuración del proveedor existente. Las pruebas automatizadas usan un analizador simulado; no acreditan disponibilidad, cuota ni calidad de una llamada real a OpenAI.

## Unidades, fecha y garantía documental

La extracción ahora incluye `items[].warranty`: `null` o `{durationMonths: integer|null, endsAt: YYYY-MM-DD|null}`. Solo corresponde a información explícita de garantía del producto completo, nunca a una suposición de marca/categoría, garantía limitada a una pieza o plazo de devolución. Se validan fechas reales y duración entre 1 y 1200 meses. Los análisis históricos que no contienen este campo siguen siendo válidos y no se reescriben.

El formulario conserva las unidades detectadas, muestra cualquier cálculo derivado y propone una unidad con aviso cuando no hay evidencia; la extracción original sigue conservando sus valores desconocidos. La fecha detectada se rellena; la desconocida queda pendiente de revisión. Las garantías detectadas o sugeridas solo se guardan mediante los campos revisados habituales `warrantyDurationMonths`/`warrantyEndsAt`. El historial distingue extracción original y confirmación. No se necesita nueva migración.
