// Puente determinístico Alertmanager <-> grupo de WhatsApp "Alertas Homelab". Sin modelo.
//
//  1. Ruta HTTP del gateway  POST /alertas/alertmanager  (receiver webhook de Alertmanager,
//     autenticado con un bearer token propio). Formatea las alertas y las envía al grupo
//     con el CLI `openclaw message send` (argv, sin shell).
//  2. Hook before_dispatch: cada mensaje del grupo (agente "alertas") se responde aquí con
//     comandos fijos contra la API v2 de Alertmanager: alertas, silenciar, silencios, quitar, ayuda.
//     El mensaje nunca llega al modelo.
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AGENTS = (process.env.ALERTAS_BRIDGE_AGENTS || "alertas").split(",").map((s) => s.trim()).filter(Boolean);
const ROUTE = process.env.ALERTAS_WEBHOOK_PATH || "/alertas/alertmanager";
const TOKEN = (process.env.ALERTAS_WEBHOOK_TOKEN || "").trim();
const GROUP = (process.env.WA_GROUP_ALERTAS || "").trim();
const AM = (process.env.ALERTAS_ALERTMANAGER_URL || "http://kube-alertmanager.monitoring.svc:9093").replace(/\/+$/, "");
const STATE_DIR = process.env.ALERTAS_STATE_DIR || path.join(process.env.HOME || "/home/node", ".openclaw", "alertas");
const CLI = (process.env.ALERTAS_OPENCLAW_CLI || "node /app/dist/index.js").split(/\s+/).filter(Boolean);
const TZ = process.env.TZ || "America/Santiago";
const MAX_BODY = 1 << 20;
const BODY_TIMEOUT_MS = 10_000;
const DEFAULT_SILENCE = "2h";
const MAX_SILENCE_MS = 30 * 24 * 3600 * 1000;
const SEVERITY_ICON = { critical: "🔴", warning: "🟠", info: "🔵" };

// ---------- estado: numeración estable de alertas (N -> fingerprint/labels) ----------
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "ultimas.json"), "utf8"));
    return { next: Number(s.next) || 1, items: Array.isArray(s.items) ? s.items : [] };
  } catch {
    return { next: 1, items: [] };
  }
}
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(STATE_DIR, "ultimas.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, path.join(STATE_DIR, "ultimas.json"));
}
// Asigna (o reutiliza) un número corto a cada alerta por fingerprint. Conserva las 60 más recientes.
function numberAlerts(alerts) {
  const state = readState();
  const byFp = new Map(state.items.map((it) => [it.fingerprint, it]));
  const out = [];
  for (const a of alerts) {
    const fp = a.fingerprint || JSON.stringify(a.labels || {});
    let it = byFp.get(fp);
    if (!it) {
      it = { n: state.next++, fingerprint: fp };
      state.items.push(it);
      byFp.set(fp, it);
    }
    it.labels = a.labels || {};
    it.ts = Date.now();
    out.push({ n: it.n, alert: a });
  }
  state.items.sort((x, y) => y.ts - x.ts);
  state.items = state.items.slice(0, 60);
  writeState(state);
  return out;
}
function findNumbered(n) {
  return readState().items.find((it) => it.n === n);
}

// ---------- utilidades ----------
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-CL", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function since(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}
const looksLikeDuration = (s) => /^\d{1,4}\s*[a-z]{1,3}$/i.test(String(s || "").trim());
function parseDuration(s) {
  const m = /^(\d{1,4})\s*(min|m|hr|h|d|sem|w)$/i.exec(String(s || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const raw = m[2].toLowerCase();
  const unit = raw === "sem" ? "w" : raw[0];
  const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit] * n;
  if (!ms || ms > MAX_SILENCE_MS) return null;
  return { ms, label: `${n}${unit}` };
}
function where(labels) {
  const parts = [];
  if (labels.namespace) parts.push(labels.namespace);
  if (labels.pod) parts.push(labels.pod);
  else if (labels.instance) parts.push(labels.instance);
  else if (labels.node) parts.push(labels.node);
  if (labels.job && !labels.pod && !labels.instance) parts.push(labels.job);
  return parts.join(" / ");
}
function tokenOk(header) {
  if (!TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error("timeout")), BODY_TIMEOUT_MS);
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        clearTimeout(timer);
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

// ---------- Alertmanager API v2 ----------
async function am(method, p, body) {
  const r = await fetch(AM + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Alertmanager ${method} ${p}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const activeAlerts = () => am("GET", "/api/v2/alerts?active=true&silenced=false&inhibited=false");
const activeSilences = async () => (await am("GET", "/api/v2/silences")).filter((s) => s.status?.state === "active" || s.status?.state === "pending");

function silenceMatchers(labels) {
  const m = [{ name: "alertname", value: labels.alertname, isRegex: false, isEqual: true }];
  for (const k of ["namespace", "instance", "node"]) {
    if (labels[k]) { m.push({ name: k, value: labels[k], isRegex: false, isEqual: true }); break; }
  }
  return m;
}
async function createSilence(labels, dur, comment) {
  const start = new Date();
  const end = new Date(start.getTime() + dur.ms);
  const r = await am("POST", "/api/v2/silences", {
    matchers: silenceMatchers(labels),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    createdBy: "alertas-homelab (WhatsApp)",
    comment: comment || "silenciado desde WhatsApp",
  });
  return { id: r?.silenceID || "", end };
}

// ---------- envío al grupo con el CLI: spool en disco + cola serial con reintentos ----------
// Cada notificación aceptada se escribe en STATE_DIR/pendientes/ ANTES de responder 202 a
// Alertmanager (que no reintenta tras un 2xx). El archivo se borra solo cuando el CLI confirma el
// envío; lo que quede pendiente (reinicio del pod, WhatsApp caído) se reenvía al arrancar.
const SPOOL = path.join(STATE_DIR, "pendientes");
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 10_000;
let queue = Promise.resolve();
let seq = 0;
function spoolWrite(text) {
  fs.mkdirSync(SPOOL, { recursive: true, mode: 0o700 });
  const file = path.join(SPOOL, `${Date.now()}-${String(++seq).padStart(4, "0")}.txt`);
  fs.writeFileSync(file + ".tmp", text, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  return file;
}
function cliSend(text, logger) {
  return new Promise((resolve) => {
    execFile(CLI[0], [...CLI.slice(1), "message", "send", "--channel", "whatsapp", "--target", GROUP, "--message", text, "--json"],
      { timeout: 120_000, maxBuffer: 1 << 20, env: process.env, cwd: "/tmp" },
      (err, stdout, stderr) => {
        if (err) logger?.warn?.(`alertas-bridge: envío falló: ${err.message} ${String(stderr || "").slice(-300)}`);
        resolve(!err);
      });
  });
}
async function deliverFile(file, logger) {
  if (!GROUP) { logger?.warn?.("alertas-bridge: WA_GROUP_ALERTAS vacío; queda en pendientes"); return false; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  for (let i = 1; i <= SEND_ATTEMPTS; i++) {
    if (await cliSend(text, logger)) {
      fs.rmSync(file, { force: true });
      logger?.info?.("alertas-bridge: alerta enviada al grupo");
      return true;
    }
    if (i < SEND_ATTEMPTS) await new Promise((r) => setTimeout(r, SEND_RETRY_MS * i));
  }
  logger?.warn?.(`alertas-bridge: ${SEND_ATTEMPTS} intentos fallidos; ${path.basename(file)} queda en pendientes para el próximo arranque`);
  return false;
}
const queued = new Set(); // archivos ya en cola: el replay del arranque no debe duplicarlos
function enqueue(file, logger) {
  if (queued.has(file)) return queue;
  queued.add(file);
  const run = () => deliverFile(file, logger).finally(() => queued.delete(file));
  queue = queue.then(run, run);
  return queue;
}
// Acepta el mensaje de forma durable; el envío sigue en la cola.
function sendToGroup(text, logger) {
  const file = spoolWrite(text);
  void enqueue(file, logger);
  return file;
}
function replaySpool(logger) {
  let files = [];
  try { files = fs.readdirSync(SPOOL).filter((f) => f.endsWith(".txt")).sort(); } catch { return 0; }
  for (const f of files) void enqueue(path.join(SPOOL, f), logger);
  if (files.length) logger?.info?.(`alertas-bridge: reenviando ${files.length} notificación(es) pendiente(s)`);
  return files.length;
}

// ---------- formato de mensajes ----------
function formatWebhook(payload) {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const firing = alerts.filter((a) => a.status === "firing");
  const resolved = alerts.filter((a) => a.status === "resolved");
  const lines = [];
  if (firing.length) {
    const numbered = numberAlerts(firing);
    const sev = firing[0].labels?.severity || "critical";
    lines.push(`${SEVERITY_ICON[sev] || "🔴"} *${firing.length === 1 ? "Alerta" : firing.length + " alertas"} ${sev === "critical" ? "crítica" : sev}${firing.length === 1 ? "" : "s"}*`);
    for (const { n, alert } of numbered) {
      const l = alert.labels || {}, an = alert.annotations || {};
      lines.push(`*${n}.* ${l.alertname}${where(l) ? ` · ${where(l)}` : ""}`);
      const txt = an.summary || an.description || an.message;
      if (txt) lines.push(`   ${String(txt).trim().slice(0, 300)}`);
      lines.push(`   desde ${fmtTime(alert.startsAt)} (${since(alert.startsAt)})`);
    }
    lines.push("");
    lines.push(`Para silenciar: *silenciar ${numbered[0].n} 2h* (o 1d, 1w) · *alertas* · *ayuda*`);
  }
  if (resolved.length) {
    if (lines.length) lines.push("");
    lines.push(`✅ *Resuelt${resolved.length === 1 ? "a" : "as"}*`);
    for (const a of resolved) {
      const l = a.labels || {};
      lines.push(`• ${l.alertname}${where(l) ? ` · ${where(l)}` : ""} (duró ${since(a.startsAt).replace("hace ", "")})`);
    }
  }
  return lines.join("\n").trim();
}
const HELP = [
  "*Alertas del homelab* (comandos, sin IA):",
  "• *alertas* — qué está sonando ahora",
  "• *silenciar 3 2h* — silencia la alerta N.º 3 por 2 h (30m, 2h, 1d, 1w; opcional un motivo al final)",
  "• *silenciar NodeDown 1d* — por nombre de alerta",
  "• *silencios* — silencios activos",
  "• *quitar a1b2c3* — quita un silencio (prefijo del id)",
].join("\n");

async function cmdAlertas() {
  const alerts = await activeAlerts();
  const real = alerts.filter((a) => a.labels?.alertname !== "Watchdog");
  if (!real.length) return "✅ Sin alertas activas (solo el latido Watchdog).";
  const numbered = numberAlerts(real.map((a) => ({ ...a, status: "firing" })));
  const lines = [`*${real.length} alerta${real.length > 1 ? "s" : ""} activa${real.length > 1 ? "s" : ""}:*`];
  for (const { n, alert } of numbered) {
    const l = alert.labels || {};
    lines.push(`*${n}.* ${SEVERITY_ICON[l.severity] || "⚪"} ${l.alertname}${where(l) ? ` · ${where(l)}` : ""} · ${since(alert.startsAt)}`);
  }
  lines.push("", "Silenciar: *silenciar <N> 2h*");
  return lines.join("\n");
}
async function cmdSilenciar(args) {
  if (!args.length) return "Uso: *silenciar <N o nombre> [duración] [motivo]*. Ej: silenciar 2 4h mantención";
  const target = args[0];
  let dur = parseDuration(args[1]);
  if (!dur && looksLikeDuration(args[1])) return `No entiendo la duración "${args[1]}". Usa 30m, 2h, 1d o 1w (máximo 30d).`;
  const rest = args.slice(dur ? 2 : 1);
  if (!dur) dur = parseDuration(DEFAULT_SILENCE);
  let labels;
  if (/^\d+$/.test(target)) {
    const it = findNumbered(Number(target));
    if (!it) return `No tengo la alerta N.º ${target}. Escribe *alertas* para renumerar.`;
    labels = it.labels;
  } else {
    const alerts = await activeAlerts();
    const hit = alerts.find((a) => (a.labels?.alertname || "").toLowerCase() === target.toLowerCase());
    labels = hit ? hit.labels : { alertname: target };
  }
  if (!labels?.alertname) return "No pude determinar qué alerta silenciar.";
  const { id, end } = await createSilence(labels, dur, rest.join(" "));
  const m = silenceMatchers(labels).map((x) => `${x.name}=${x.value}`).join(", ");
  return `🔇 Silenciada *${labels.alertname}* por ${dur.label} (hasta ${fmtTime(end.toISOString())}).\nAlcance: ${m}\nId: ${id.slice(0, 8)} · para quitarla: *quitar ${id.slice(0, 8)}*`;
}
async function cmdSilencios() {
  const sil = await activeSilences();
  if (!sil.length) return "No hay silencios activos.";
  return ["*Silencios activos:*", ...sil.map((s) => `• ${s.id.slice(0, 8)} · ${s.matchers.map((m) => `${m.name}=${m.value}`).join(", ")} · hasta ${fmtTime(s.endsAt)}${s.comment ? ` · ${s.comment}` : ""}`)].join("\n");
}
async function cmdQuitar(args) {
  const pref = (args[0] || "").toLowerCase();
  if (pref.length < 4) return "Uso: *quitar <id>* (al menos 4 caracteres del id; ver *silencios*)";
  const sil = (await activeSilences()).filter((s) => s.id.toLowerCase().startsWith(pref));
  if (!sil.length) return `No hay un silencio activo que empiece por ${pref}.`;
  if (sil.length > 1) return `Hay ${sil.length} silencios que empiezan por ${pref}; escribe más caracteres.`;
  await am("DELETE", `/api/v2/silence/${sil[0].id}`);
  return `🔔 Silencio ${sil[0].id.slice(0, 8)} quitado (${sil[0].matchers.map((m) => `${m.name}=${m.value}`).join(", ")}).`;
}
async function handleCommand(text) {
  const words = text.trim().replace(/^[\s*_]+|[\s*_]+$/g, "").split(/\s+/);
  const cmd = (words[0] || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const args = words.slice(1);
  switch (cmd) {
    case "alertas": case "estado": case "status": return cmdAlertas();
    case "silenciar": case "silencio": case "mute": return cmdSilenciar(args);
    case "silencios": case "silenciadas": return cmdSilencios();
    case "quitar": case "reactivar": case "unmute": return cmdQuitar(args);
    case "ayuda": case "help": case "?": return HELP;
    default: return `No entendí "${words[0]}".\n${HELP}`;
  }
}

export default {
  id: "alertas-bridge",
  name: "Alertas bridge",
  description: "Alertmanager -> WhatsApp y comandos de silencio, sin modelo.",
  register(api) {
    if (!TOKEN) api.logger?.warn?.("alertas-bridge: ALERTAS_WEBHOOK_TOKEN vacío; el webhook rechazará todo");
    // Deja pasar unos segundos para que el gateway (y el canal de WhatsApp) termine de arrancar.
    setTimeout(() => { try { replaySpool(api.logger); } catch (e) { api.logger?.warn?.(`alertas-bridge: replay falló: ${e?.message || e}`); } }, 20_000).unref?.();
    api.registerHttpRoute({
      path: ROUTE,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(res, 405, { error: "method not allowed" }); }
        if (!tokenOk(req.headers?.authorization)) return reply(res, 401, { error: "unauthorized" });
        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          return reply(res, /large/.test(String(e?.message)) ? 413 : 400, { error: String(e?.message || e) });
        }
        let text;
        try {
          text = formatWebhook(payload);
        } catch (e) {
          api.logger?.warn?.(`alertas-bridge: formato falló: ${e?.message || e}`);
          return reply(res, 400, { error: "bad payload" });
        }
        if (!text) return reply(res, 200, { ok: true, sent: false });
        // Persistir antes de responder: Alertmanager no reintenta tras un 2xx y el CLI tarda ~20 s.
        try {
          sendToGroup(text, api.logger);
        } catch (e) {
          api.logger?.warn?.(`alertas-bridge: no pude guardar la notificación: ${e?.message || e}`);
          return reply(res, 503, { error: "spool unavailable" }); // Alertmanager reintentará
        }
        return reply(res, 202, { ok: true, queued: true });
      },
    });

    api.on("before_dispatch", async (event, ctx) => {
      const key = String(event?.sessionKey || ctx?.sessionKey || "");
      const agent = /^agent:([^:]+):/.exec(key)?.[1];
      if (!agent || !AGENTS.includes(agent)) return undefined; // no es nuestro: despacho normal
      if ((event?.channel || ctx?.channelId) !== "whatsapp" || !event?.isGroup) return undefined;
      const text = String(event?.content ?? event?.body ?? "").trim().slice(0, 500);
      if (!text) return { handled: true };
      try {
        return { handled: true, text: await handleCommand(text) };
      } catch (e) {
        api.logger?.warn?.(`alertas-bridge: ${e?.message || e}`);
        return { handled: true, text: "⚠️ No pude hablar con Alertmanager. Intenta de nuevo en un momento." };
      }
    });
  },
};
