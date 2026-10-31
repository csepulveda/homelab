# gastos

Registra en Google Sheets las compras con débito, las transferencias y las cartolas de BCI que llegan a Gmail. Corre dentro del pod de OpenClaw.

| Pieza | Qué hace |
|---|---|
| `gastos_parse.py` | Parser determinístico de los correos y de la cartola en PDF. La cartola se valida contra su "Resumen del Periodo". |
| `gastos` | CLI: `init`, `sync`, `cartola`, `responder`, `corregir`, `pendientes`. Su salida estándar se envía por WhatsApp; la salida `NO_REPLY` significa no enviar nada. |
| `SKILL.md` | Skill del agente: cuando respondes a una pregunta de gastos, el agente ejecuta `gastos responder "<mensaje>"`. |

La categorización sigue este orden: reglas aprendidas (pestaña Reglas), luego reglas fijas, y al final el modelo local (`ollama.primaryModel`, mismo `num_ctx` que OpenClaw). Si la confianza es menor a `gastos.umbral`, o la contraparte es nueva durante el período de aprendizaje, o es un destinatario de transferencia nuevo, o es una pasarela de pago (MERCADOPAGO*, TUU*…), te pregunta por WhatsApp.

## Seguridad

- El agente solo puede ejecutar `/opt/gastos/gastos responder|corregir|pendientes` (ver `templates/exec-approvals.yaml`).
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
  "GASTOS_OWN_NAMES":"<nombre apellido>,<inicial.apellido>"}}'

# 2. Token de gog autorizado en otra máquina (GOG_HOME con keyring "file"):
COPYFILE_DISABLE=1 tar -C "$GOG_HOME" -cf - . | kubectl -n openclaw exec -i deploy/openclaw -c gateway -- \
  sh -c 'mkdir -p -m 700 ~/.openclaw/gog && tar -C ~/.openclaw/gog -xf - && chmod -R go-rwx ~/.openclaw/gog'

# 3. Planilla y backfill
oc() { kubectl -n openclaw exec deploy/openclaw -c gateway -- node /app/dist/index.js "$@"; }
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos init
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos sync --backfill --dias 120
kubectl -n openclaw exec deploy/openclaw -c gateway -- gastos cartola --backfill --dias 130

# 4. Crons (quedan en el estado del PVC). TO = número de WhatsApp en E.164
oc automations create "*/2 * * * *" --name "gastos: sync" --tz America/Santiago \
  --command-argv '["/opt/gastos/gastos","sync"]' --timeout-seconds 300 --announce --channel whatsapp --to "$TO"
oc automations create "0 10 * * *" --name "gastos: cartola" --tz America/Santiago \
  --command-argv '["/opt/gastos/gastos","cartola"]' --timeout-seconds 600 --announce --channel whatsapp --to "$TO"
oc automations create "0 21 * * *" --name "gastos: pendientes" --tz America/Santiago \
  --command-argv '["/opt/gastos/gastos","pendientes","--recordatorio"]' --announce --channel whatsapp --to "$TO"
```

## Pestañas de la planilla

- **Gastos**: ID (G = compra, T = transferencia, C = cartola), fecha, hora, monto, tipo, contraparte, categoría, fijo, detalle, cuenta, estado (`auto`/`pendiente`/`revisar`/`confirmado`), fuente, conciliado y origen (comprobante o ID de Gmail).
- **Reglas**: lo que aprende de tus respuestas. Se puede editar a mano; la columna "Preguntar siempre" sirve para contrapartes que varían.
- **Cartolas**: períodos procesados y si cuadraron.

No suman al gasto: Traspaso propio, Pago tarjeta, Préstamo e Ingreso.
