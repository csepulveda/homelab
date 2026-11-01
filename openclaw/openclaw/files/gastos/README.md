# gastos

Registra en Google Sheets las compras con débito, las transferencias y las cartolas de BCI que llegan a Gmail. Corre dentro del pod de OpenClaw.

| Pieza | Qué hace |
|---|---|
| `gastos_parse.py` | Parser determinístico de los correos de BCI, de los comprobantes de Servipag y de la cartola en PDF. La cartola se valida contra su "Resumen del Periodo". |
| `gastos` | CLI: `init`, `sync`, `cartola`, `responder`, `corregir`, `pendientes`, `resumen`, `regla`, `categoria`, `reaplicar`, `export` (JSON de toda la planilla para el análisis mensual). Su salida estándar se envía por WhatsApp; la salida `NO_REPLY` significa no enviar nada. |
| `../gastos-bridge/` | Plugin de OpenClaw (hook `before_dispatch`) que responde los mensajes del grupo ejecutando `gastos responder <mensaje>` (argv, sin shell) y devolviendo su salida tal cual, **sin turno del modelo**. |
| `AGENTS-gastos.md` | Instrucciones del agente `gastos`, que atiende el grupo de WhatsApp "Control Gastos": cada mensaje se pasa tal cual a `gastos responder "<mensaje>"`, y el CLI decide si es una respuesta, "pendientes", "corregir G5 …" o "ayuda". |

Cada movimiento nuevo se pregunta por WhatsApp con una categoría sugerida (regla determinística para comercios conocidos, si no el modelo local `ollama.primaryModel`, mismo `num_ctx` que OpenClaw). Solo se registran sin preguntar los traspasos a cuentas propias, los pagos de tarjeta y lo que ya tiene una regla permanente en la pestaña Reglas. La respuesta decide qué se aprende:

- `G12 2` o `G12 restaurante`: solo ese movimiento; la próxima vez vuelve a preguntar por ese comercio.
- `G12 restaurante permanente`: guarda la regla y no vuelve a preguntar por ese comercio.
- `G12 arriendo fijo`: regla permanente y además marca el gasto como fijo mensual (columna Fijo).

A las 21:30 llega un resumen (`gastos resumen`) de las 24 h desde el corte anterior (21:30 a 21:30): total, número de gastos y detalle, incluidos los que se registraron solos por regla, y al final los pendientes si los hay. Pedido por chat ("resumen") cubre desde el último corte hasta ese momento.

## Seguridad

- El agente `gastos` solo puede ejecutar `/opt/gastos-tools/gastos responder …`, y `main` no puede ejecutar nada (ver `templates/exec-approvals.yaml`).
- WhatsApp solo admite los grupos de `.Values.whatsappGroups`. sync-config reescribe `channels.whatsapp.groups` y `bindings` en cada arranque, y cualquier otro grupo se descarta antes del modelo. Los JID van en el Secret.
- Las herramientas de archivos del agente solo alcanzan el workspace (`tools.fs.workspaceOnly`).
- gog y pypdf se descargan con verificación de sha256 a un emptyDir que el gateway monta read-only. El CLI viene del ConfigMap, también read-only.
- gog corre con `--gmail-no-send --enable-commands gmail.messages.search,gmail.raw,sheets`. Los permisos OAuth son `gmail.readonly`, `spreadsheets` y `drive.file`.
- El token OAuth está en `~/.openclaw/gog`, fuera del workspace y cifrado con `GOG_KEYRING_PASSWORD`.

## Fuera de git (una vez)

```bash
# 1. Secret (el repo es público: datos personales solo aquí)
kubectl -n openclaw patch secret openclaw-secrets --type merge -p '{"stringData":{
  "GOG_KEYRING_PASSWORD":"<clave keyring gog>",
  "BCI_PDF_PASSWORD":"<RUT sin DV>",
  "GASTOS_ACCOUNT":"<cuenta gmail>",
  "GASTOS_SHEET_ID":"<id planilla>",
  "GASTOS_OWN_NAMES":"<nombre apellido>,<inicial.apellido>",
  "WA_GROUP_GASTOS":"<jid del grupo, 1203...@g.us>"}}'

# 2. Token de gog autorizado en otra máquina (GOG_HOME con keyring "file"):
COPYFILE_DISABLE=1 tar -C "$GOG_HOME" -cf - . | kubectl -n openclaw exec -i deploy/openclaw -c gateway -- \
  sh -c 'mkdir -p -m 700 ~/.openclaw/gog && tar -C ~/.openclaw/gog -xf - && chmod -R go-rwx ~/.openclaw/gog'

# 3. Planilla y backfill
oc() { kubectl -n openclaw exec deploy/openclaw -c gateway -- node /app/dist/index.js "$@"; }
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos init
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos sync --backfill --dias 120
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos cartola --backfill --dias 130

# 4. Crons (quedan en el estado del PVC)
TO="1203...@g.us"   # JID del grupo de gastos (los avisos llegan al grupo)
oc automations create "*/2 * * * *" --name "gastos: sync" --tz America/Santiago \
  --command-argv '["/opt/gastos-tools/gastos","sync"]' --timeout-seconds 300 --announce --channel whatsapp --to "$TO"
oc automations create "0 10 * * *" --name "gastos: cartola" --tz America/Santiago \
  --command-argv '["/opt/gastos-tools/gastos","cartola"]' --timeout-seconds 600 --announce --channel whatsapp --to "$TO"
oc automations create "30 21 * * *" --name "gastos: resumen" --tz America/Santiago \
  --command-argv '["/opt/gastos-tools/gastos","resumen"]' --announce --channel whatsapp --to "$TO"
```

## Pestañas de la planilla

- **Gastos**: ID (G = compra, T = transferencia, C = cartola), fecha, hora, monto, tipo, contraparte, categoría, fijo, detalle, cuenta, estado (`auto`/`pendiente`/`revisar`/`confirmado`), fuente, conciliado y origen (comprobante o ID de Gmail).
- **Reglas**: solo lo que pediste guardar con "permanente" o "fijo" (o con `regla …`). Se puede editar a mano; la columna "Preguntar siempre" deja una regla como sugerencia que igual pregunta. Tipos de regla:
  - `Compra`, `Transferencia` y `Cartola` usan la contraparte exacta. Las transferencias de la cartola (`TRANSFER A J.PEREZ ROJA`) también coinciden por nombre abreviado con la regla del correo.
  - `Contiene` aplica a todo movimiento cuyo nombre o mensaje contenga el texto: `gastos regla taller Transporte`, o por WhatsApp "regla taller = Transporte".
  - Cada regla nueva o corregida se aplica **retroactivamente** a la planilla, sin tocar las filas ya confirmadas a mano. `gastos reaplicar` vuelve a correr todas las reglas con la misma excepción.
- **Categorías**: nombre, descripción (gemma la usa para sugerir) y si suma al gasto. Se edita en la planilla, con `gastos categoria "Mascotas" "descripción" [--no-suma]`, o por WhatsApp: "G12 nueva Regalos" (crea y asigna) o "nueva Regalos: descripción" (solo crea).
- **Cartolas**: períodos procesados y si cuadraron.

Por defecto no suman al gasto: Traspaso propio, Pago tarjeta, Préstamo e Ingreso (columna "Suma al gasto" de Categorías).
