import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { createServer } from "vite";

const root = process.env.KULO_DESKTOP_DEV_ROOT;
const hub = new URL(process.env.KULO_DESKTOP_HUB_URL);
if (!root || !path.isAbsolute(root) || hub.protocol !== "http:" || hub.hostname !== "127.0.0.1" || !hub.port || hub.username || hub.password || hub.pathname !== "/" || hub.search || hub.hash || !process.send) {
  throw new Error("开发服务器需要桌面客户端提供本机 Hub 地址。");
}
const proxy = () => ({
  target: hub.origin,
  changeOrigin: true,
  ws: true,
  configure(instance) {
    const preserveOrigin = (outgoing, incoming) => {
      if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader("origin", hub.origin);
    };
    instance.on("proxyReq", preserveOrigin);
    instance.on("proxyReqWs", preserveOrigin);
  },
});
const portFile = path.join(process.env.KULO_DESKTOP_DATA_DIR, "vite-port");
let preferredPort = 0;
try {
  const descriptor = fs.openSync(portFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("开发服务器端口文件无效。");
    const saved = fs.readFileSync(descriptor, "utf8");
    if (!/^[0-9]{1,5}$/.test(saved) || Number(saved) < 1 || Number(saved) > 65535) throw new Error("开发服务器端口文件无效。");
    preferredPort = Number(saved);
  } finally { fs.closeSync(descriptor); }
} catch (error) { if (error.code !== "ENOENT") throw error; }
// Vite treats port 0 as its default port, so choose the first development port explicitly.
if (!preferredPort) {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("无法分配开发服务器端口。");
  preferredPort = port;
}
const existingPort = fs.existsSync(portFile);
const server = await createServer({
  root: path.join(root, "packages/web"),
  configFile: path.join(root, "packages/web/vite.config.ts"),
  clearScreen: false,
  server: {
    host: "127.0.0.1", port: preferredPort, strictPort: true,
    proxy: { "/api": proxy(), "/ws": proxy() },
    fs: { strict: true },
  },
});
let stopping;
function stop(code = 0) {
  return stopping ??= server.close().then(() => process.exit(code)).catch(() => process.exit(1));
}
process.on("message", (message) => { if (message?.type === "shutdown") void stop(); });
process.once("disconnect", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("开发服务器未能监听本机端口。");
if (!existingPort) {
  const temporary = `${portFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, String(address.port), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, portFile);
}
process.send({ type: "ready", url: `http://127.0.0.1:${address.port}` });
