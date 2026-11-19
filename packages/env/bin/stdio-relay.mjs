#!/usr/bin/env node
/**
 * Zero-dependency loopback TCP <-> stdio relay used by @earendil-works/pi-env's `Connection`.
 * Invoked as: node stdio-relay.mjs <port> <envId> <secret> serve --token <daemonToken>
 */
import net from "node:net";

const [, , portArg, envId, secret, ...remainingArgs] = process.argv;
const scopeArg = remainingArgs[0] === "serve" ? undefined : remainingArgs.shift();
const [subcmd, tokenFlag, daemonToken] = remainingArgs;
const port = Number(portArg);
let scope = {};
try {
  if (scopeArg) scope = JSON.parse(scopeArg);
} catch {
  process.stderr.write("Invalid Worker scope\n");
  process.exit(2);
}

if (!port || !envId || !secret || subcmd !== "serve" || tokenFlag !== "--token" || !daemonToken) {
  process.stderr.write("Invalid stdio-relay arguments\n");
  process.exit(2);
}

const socket = net.createConnection({ host: "127.0.0.1", port });
let handshakeDone = false;
let lineBuf = Buffer.alloc(0);

socket.once("connect", () => {
  const header = JSON.stringify({ ...scope, envId, secret, daemonToken }) + "\n";
  socket.write(header);
});

socket.on("data", (chunk) => {
  if (handshakeDone) {
    process.stdout.write(chunk);
    return;
  }
  lineBuf = Buffer.concat([lineBuf, chunk]);
  const nl = lineBuf.indexOf(0x0a);
  if (nl === -1) return;

  const statusLine = lineBuf.subarray(0, nl).toString("utf8").trim();
  const remainder = lineBuf.subarray(nl + 1);
  lineBuf = Buffer.alloc(0);

  if (statusLine !== "OK") {
    process.stderr.write(`${statusLine}\n`);
    socket.destroy();
    process.exit(1);
  }

  handshakeDone = true;
  if (remainder.byteLength > 0) {
    process.stdout.write(remainder);
  }
  process.stdin.pipe(socket);
});

socket.on("end", () => {
  process.exit(handshakeDone ? 0 : 1);
});

socket.on("close", () => {
  process.exit(handshakeDone ? 0 : 1);
});

socket.on("error", (err) => {
  process.stderr.write(`Bridge socket error: ${err.message}\n`);
  process.exit(1);
});

process.stdout.on("error", () => {
  socket.destroy();
  process.exit(0);
});
