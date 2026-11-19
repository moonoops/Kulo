import fs from "node:fs";

const source = new URL("../skills/", import.meta.url);
const destination = new URL("../dist/skills/", import.meta.url);
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
