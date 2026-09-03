# Funciones futuras

Fuera del MVP y no implementadas:

- Importación CSV y Excel para facturas o variables.
- Sincronización e importación bancaria automática.
- Aplicaciones Android, iOS y React Native.
- OCR de facturas.
- IA para categorizar.
- Predicciones avanzadas.

## Preparación arquitectónica

- La API no depende de React y podrá servir otros clientes.
- Los servicios financieros reciben datos normalizados; un importador futuro terminará en los mismos validadores/servicios.
- `VariableExpenseMonth` evita doble conteo, por lo que una importación deberá elegir o confirmar el cambio entre detalle y resumen.
- Se conservan referencias e históricos, y los importadores deberán ser idempotentes mediante una referencia externa o hash.
- No se crean ahora abstracciones de importación, OCR o banca sin un caso real. Los documentos de factura existentes conservan su implementación acotada y no anticipan OCR.

La sincronización bancaria cambiaría sustancialmente privacidad, consentimiento, conciliación y modelo de datos. No debe añadirse como una simple extensión del saldo global.
