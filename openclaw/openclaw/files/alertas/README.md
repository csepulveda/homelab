# alertas: Alertmanager → WhatsApp (grupo "Alertas Homelab")

Todo es script, sin modelo. Corre dentro del pod de OpenClaw como plugin `alertas-bridge`.

| Pieza | Qué hace |
|---|---|
| `../alertas-bridge/index.js` | Plugin de OpenClaw. (1) Registra la ruta `POST /alertas/alertmanager` del gateway: recibe el webhook de Alertmanager (bearer token propio), numera las alertas y las publica en el grupo con `openclaw message send`. (2) Hook `before_dispatch`: responde los mensajes del grupo con comandos fijos contra la API v2 de Alertmanager (`kube-alertmanager.monitoring.svc:9093`). |
| `AGENTS-alertas.md` | Respaldo para el agente `alertas` si algún mensaje llegara al modelo: solo repite la lista de comandos. El agente no tiene exec ni herramientas. |

## Comandos en el grupo

- `alertas` — alertas activas (sin Watchdog), numeradas.
- `silenciar <N> [2h|1d|1w] [motivo]` — silencia la alerta N.º N (por defecto 2 h). También `silenciar <alertname> 1d`.
  El silencio abarca `alertname` más `namespace`, `instance` o `node` si la alerta lo trae.
- `silencios` — silencios activos. `quitar <prefijo id>` — lo elimina.
- `ayuda`.

## Qué llega

Alertmanager (`monitoring/kube/values.yaml`) rutea `severity = critical` al receiver `whatsapp-homelab`,
con `send_resolved: true`. Las warnings e info siguen en `null`. Cada notificación se guarda en
`~/.openclaw/alertas/pendientes/` antes de responder 202 (Alertmanager no reintenta tras un 2xx); una cola
serial la envía con el CLI (~20 s por mensaje, 3 intentos) y borra el archivo al confirmar. Lo pendiente se
reenvía al arrancar el gateway.

## Secretos (fuera de git)

```bash
TOKEN=$(openssl rand -hex 32)
kubectl -n openclaw patch secret openclaw-secrets -p "{\"stringData\":{\"WA_GROUP_ALERTAS\":\"1203...@g.us\",\"ALERTAS_WEBHOOK_TOKEN\":\"$TOKEN\"}}"
kubectl -n monitoring create secret generic alertmanager-openclaw --from-literal=token="$TOKEN"
```

El JID del grupo se obtiene con `openclaw directory groups list --channel whatsapp` o buscando el nombre
del grupo en `~/.openclaw/state/openclaw.sqlite`.

## Probar

```bash
# alerta sintética crítica (se resuelve sola en 5 min)
kubectl -n monitoring exec alertmanager-kube-alertmanager-0 -c alertmanager -- \
  amtool alert add PruebaWhatsApp severity=critical namespace=pruebas \
  --annotation=summary="prueba del canal" --end="$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ)"
```
