import { StringDecoder } from "node:string_decoder";

export interface ExternalAgentPipe {
  write(data: string): void;
  close(): void;
  exited: Promise<number>;
  cleanup?: () => Promise<boolean>;
}

export interface ExternalAgentPipeOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  isolated: boolean;
  readOnly: boolean;
  runtimePaths: string[];
  bootstrap?: "gemini-api";
  onStdout: (data: Uint8Array) => void;
  onStderr: (data: Uint8Array) => void;
}

export type ExternalAgentPipeFactory = (options: ExternalAgentPipeOptions) => Promise<ExternalAgentPipe>;
export type RpcValue = Record<string, unknown>;

/** One protocol connection; late responses never resolve requests from a replacement process. */
export class ExternalAgentRpc {
  #pipe?: ExternalAgentPipe;
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #nextId = 1;
  #closed = false;
  #pending = new Map<number, { resolve: (value: RpcValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #request: (method: string, params: RpcValue, id: string | number) => Promise<unknown>;
  #notification: (method: string, params: RpcValue) => void;
  #failed: (error: Error) => void;

  constructor(handlers: {
    request: (method: string, params: RpcValue, id: string | number) => Promise<unknown>;
    notification: (method: string, params: RpcValue) => void;
    failed: (error: Error) => void;
  }) {
    this.#request = handlers.request;
    this.#notification = handlers.notification;
    this.#failed = handlers.failed;
  }

  attach(pipe: ExternalAgentPipe): void {
    if (this.#pipe || this.#closed) { pipe.close(); throw new Error("Agent protocol connection is already attached or closed"); }
    this.#pipe = pipe;
    void pipe.exited.then((code) => this.#fail(new Error(`Agent process exited (${code})`)), (error: unknown) => this.#fail(error instanceof Error ? error : new Error("Agent process exited")));
  }

  accept(data: Uint8Array): void {
    if (this.#closed) return;
    this.#buffer += this.#decoder.write(Buffer.from(data));
    if (Buffer.byteLength(this.#buffer) > 8 * 1024 * 1024) { this.#fail(new Error("Agent protocol frame exceeds its size limit")); this.#pipe?.close(); return; }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcValue;
      try { message = JSON.parse(line) as RpcValue; }
      catch { this.#fail(new Error("Agent emitted invalid protocol JSON")); this.#pipe?.close(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { this.#fail(new Error("Agent emitted an invalid protocol message")); return; }
      if (typeof message.method === "string") {
        const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params as RpcValue : {};
        if (typeof message.id === "number" || typeof message.id === "string") {
          const id = message.id;
          void this.#request(message.method, params, id).then(
            (result) => this.#respond(id, result),
            () => this.#respond(id, undefined, { code: -32603, message: "Client refused the agent request" }),
          );
        } else this.#notification(message.method, params);
      } else if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) {
          const error = message.error as RpcValue;
          pending.reject(new Error(typeof error.message === "string" ? error.message.slice(0, 2000) : "Agent protocol request failed"));
        } else pending.resolve(message.result && typeof message.result === "object" ? message.result as RpcValue : {});
      }
    }
  }

  call(method: string, params: RpcValue, timeoutMs = 30_000): Promise<RpcValue> {
    if (!this.#pipe || this.#closed) return Promise.reject(new Error("Agent protocol connection is not available"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Agent did not confirm ${method}; inspect before retrying`)); }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#pipe!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { this.#pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  notify(method: string, params: RpcValue): void {
    if (!this.#pipe || this.#closed) throw new Error("Agent protocol connection is not available");
    this.#pipe.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    const pipe = this.#pipe;
    this.#fail(new Error("Agent protocol connection closed"), false);
    pipe?.close();
  }

  #respond(id: number | string, result: unknown, error?: RpcValue): void {
    if (this.#closed || !this.#pipe) return;
    this.#pipe.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result: result ?? {} }) })}\n`);
  }

  #fail(error: Error, notify = true): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (notify) this.#failed(error);
  }
}
