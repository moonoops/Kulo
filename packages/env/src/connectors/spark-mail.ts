import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ConnectorCallRequest, ConnectorCallResult } from "@kulo/protocol";

const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_ID_RE = /^[A-Za-z0-9._:@/+=-]{1,200}$/;
const SAFE_ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export type SparkExecResult = { ok: boolean; stdout: string; stderr: string; code?: string };
export type SparkExecRunner = (exe: string, args: string[], timeoutMs: number) => Promise<SparkExecResult>;

export interface SparkMailConnectorOptions {
  executablePath?: string;
  runner?: SparkExecRunner;
  timeoutMs?: number;
}

export function findSparkExecutable(explicit?: string): string | undefined {
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch {
      return undefined;
    }
  }
  const candidates = [
    "/opt/homebrew/bin/spark",
    "/usr/local/bin/spark",
    path.join(os.homedir(), ".local/bin/spark"),
    "/Applications/Spark Desktop.app/Contents/Resources/spark",
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "spark")),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

function defaultExecRunner(exe: string, args: string[], timeoutMs: number): Promise<SparkExecResult> {
  return new Promise((resolve) => {
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: `/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), ".local/bin")}:/usr/bin:/bin`,
      HOME: os.homedir(),
      TMPDIR: os.tmpdir(),
      LANG: "en_US.UTF-8",
    };
    execFile(
      exe,
      args,
      {
        env: cleanEnv,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException).code === "string"
            ? (error as NodeJS.ErrnoException).code
            : error.killed
              ? "timeout"
              : "exec_failed";
          resolve({
            ok: false,
            stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
            stderr: String(stderr ?? error.message ?? "").slice(0, 2_000),
            code,
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
          stderr: String(stderr ?? "").slice(0, 2_000),
        });
      },
    );
  });
}

function safeLine(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "").trim().slice(0, maxLen);
}

function assertNotFlag(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} 不能以 '-' 开头`);
  }
}

export function buildSparkCliArgs(request: ConnectorCallRequest): string[] {
  const params = request.params ?? {};
  switch (request.action) {
    case "status":
      return ["accounts", "--json"];
    case "list_emails": {
      const args = ["emails", "--json"];
      const limit = Number(params.limit);
      if (Number.isInteger(limit) && limit >= 1 && limit <= 50) {
        args.push("--limit", String(limit));
      } else {
        args.push("--limit", "20");
      }
      const folder = safeLine(params.folder, 80);
      if (folder) {
        assertNotFlag(folder, "folder");
        args.push("--folder", folder);
      }
      if (params.unread === true) {
        args.push("--unread");
      }
      return args;
    }
    case "search": {
      const query = safeLine(params.query, 300);
      if (!query) throw new Error("search 需要提供 query 参数");
      assertNotFlag(query, "query");
      const args = ["search", "--json"];
      const limit = Number(params.limit);
      if (Number.isInteger(limit) && limit >= 1 && limit <= 50) {
        args.push("--limit", String(limit));
      }
      args.push(query);
      return args;
    }
    case "read_thread": {
      const threadId = safeLine(params.threadId, 200);
      if (!threadId || !SAFE_ID_RE.test(threadId) || threadId.startsWith("-")) {
        throw new Error("read_thread 需要合法的 threadId");
      }
      return ["thread", "--json", threadId];
    }
    case "list_events": {
      const args = ["events", "--json"];
      const from = safeLine(params.from, 40);
      const to = safeLine(params.to, 40);
      if (from && SAFE_ISO_RE.test(from)) args.push("--from", from);
      if (to && SAFE_ISO_RE.test(to)) args.push("--to", to);
      return args;
    }
    case "create_draft": {
      const body = safeLine(params.body, 8_000);
      if (!body) throw new Error("create_draft 需要提供正文 body");
      const args = ["draft", "create", "--json"];
      const replyTo = safeLine(params.replyToThreadId, 200);
      if (replyTo) {
        if (!SAFE_ID_RE.test(replyTo) || replyTo.startsWith("-")) throw new Error("replyToThreadId 格式无效");
        args.push("--reply-to", replyTo);
      }
      const to = safeLine(params.to, 320);
      if (to) {
        assertNotFlag(to, "to");
        args.push("--to", to);
      }
      const subject = safeLine(params.subject, 240);
      if (subject) {
        assertNotFlag(subject, "subject");
        args.push("--subject", subject);
      }
      args.push("--body", body);
      return args;
    }
  }
}

export function inferSparkAccessTier(parsed: unknown): "off" | "read" | "triage" | "send" | "unknown" {
  const text = JSON.stringify(parsed ?? "").toLowerCase();
  if (text.includes('"send"') || text.includes("send_access")) return "send";
  if (text.includes('"triage"') || text.includes("draft")) return "triage";
  if (text.includes('"read"') || text.includes("accounts")) return "read";
  return "unknown";
}

export class SparkMailConnector {
  readonly #options: SparkMailConnectorOptions;
  readonly #timeoutMs: number;

  constructor(options: SparkMailConnectorOptions = {}) {
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async invoke(request: ConnectorCallRequest): Promise<ConnectorCallResult> {
    if (request.driverId !== "spark-mail") {
      return { ok: false, code: "unsupported_driver", error: "Unsupported connector driver" };
    }
    const exe = this.#options.runner ? (this.#options.executablePath ?? "spark") : findSparkExecutable(this.#options.executablePath);
    if (!exe) {
      return {
        ok: false,
        code: "spark_cli_not_installed",
        error: "未检测到 Spark CLI，请在 Spark Desktop「设置 → AI Agents → Setup CLI」中启用。",
      };
    }

    let args: string[];
    try {
      args = buildSparkCliArgs(request);
    } catch (error) {
      return {
        ok: false,
        code: "invalid_params",
        error: error instanceof Error ? error.message : "Spark 请求参数无效",
      };
    }

    const runner = this.#options.runner ?? defaultExecRunner;
    const res = await runner(exe, args, this.#timeoutMs);
    if (!res.ok) {
      return {
        ok: false,
        code: res.code ?? "spark_cli_error",
        error: (res.stderr || res.stdout || "Spark CLI 调用失败，请确认 Spark Desktop 正在运行且已授权访问。").trim().slice(0, 500),
      };
    }

    let data: unknown = res.stdout.trim();
    if (typeof data === "string" && (data.startsWith("{") || data.startsWith("["))) {
      try {
        data = JSON.parse(data);
      } catch {
        // Return bounded raw text if CLI returned non-JSON output.
      }
    }
    if (request.action === "status") {
      const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const accounts = Array.isArray(obj.accounts) ? obj.accounts : Array.isArray(data) ? data : [];
      return {
        ok: true,
        data: {
          available: true,
          accessTier: inferSparkAccessTier(data),
          accountCount: accounts.length,
          accounts,
        },
      };
    }
    return { ok: true, data };
  }
}
