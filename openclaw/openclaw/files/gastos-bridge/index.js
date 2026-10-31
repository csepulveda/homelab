// Puente determinístico: cada mensaje de un grupo ruteado a un agente "bridge" se pasa al CLI
// `gastos responder <texto>` (argv, sin shell) y su stdout es la respuesta. El modelo no participa,
// así que no puede parafrasear ni responder "de memoria". Para cualquier otro mensaje no hace nada.
import { execFile } from "node:child_process";

const CLI = process.env.GASTOS_BRIDGE_CLI || "/opt/gastos-tools/gastos";
const AGENTS = (process.env.GASTOS_BRIDGE_AGENTS || "gastos").split(",").map((s) => s.trim()).filter(Boolean);
const ERROR = "No pude procesar eso (error del registro de gastos).";

function runCli(text) {
  return new Promise((resolve) => {
    execFile(CLI, ["responder", text], { timeout: 280_000, maxBuffer: 1 << 20, env: process.env },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

export default {
  id: "gastos-bridge",
  name: "Gastos bridge",
  description: "Responde los grupos de agentes bridge con el CLI gastos, sin modelo.",
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      const key = String(event?.sessionKey || ctx?.sessionKey || "");
      const agent = /^agent:([^:]+):/.exec(key)?.[1];
      if (!agent || !AGENTS.includes(agent)) return undefined; // no es nuestro: despacho normal
      if ((event?.channel || ctx?.channelId) !== "whatsapp" || !event?.isGroup) return undefined;

      const text = String(event?.content ?? event?.body ?? "").trim().slice(0, 4000);
      if (!text) return { handled: true };
      try {
        const r = await runCli(text);
        const out = r.stdout.trim();
        if (r.err && !out) {
          api.logger?.warn?.(`gastos-bridge: CLI falló: ${r.err.message} ${r.stderr.slice(-300)}`);
          return { handled: true, text: ERROR };
        }
        if (out === "NO_REPLY" || !out) return { handled: true };
        return { handled: true, text: out };
      } catch (e) {
        // Nunca soltar el mensaje al modelo: responder el error.
        api.logger?.warn?.(`gastos-bridge: ${e?.message || e}`);
        return { handled: true, text: ERROR };
      }
    });
  },
};
