import { pathToFileURL } from "node:url";
import { proxyFetch } from "./http-transport.js";

// Keep the official server unchanged while giving its fetch calls the same proxy policy as the Hub.
const entry = process.argv[2];
if (!entry) throw new Error("Missing search MCP server entrypoint");
globalThis.fetch = proxyFetch;
process.argv = [process.argv[0]!, entry, ...process.argv.slice(3)];
await import(pathToFileURL(entry).href);
