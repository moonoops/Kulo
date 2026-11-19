import type { ClientToHubMessage } from "@moco/protocol";

export interface PendingWsAcknowledgement<Result> {
  action: ClientToHubMessage["type"];
  promise: Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function sendWithAcknowledgement<Result>(
  pending: Map<string, PendingWsAcknowledgement<Result>>,
  key: string,
  action: ClientToHubMessage["type"],
  send: () => void,
  timeoutError: () => Error,
  timeoutMs: number,
): Promise<Result> {
  const existing = pending.get(key);
  if (existing) return existing.action === action
    ? existing.promise
    : Promise.reject(new Error("消息标识正在用于另一项请求"));

  let accepted!: (result: Result) => void;
  let refused!: (error: Error) => void;
  const promise = new Promise<Result>((resolve, reject) => { accepted = resolve; refused = reject; });
  const finish = () => { clearTimeout(request.timer); pending.delete(key); };
  const request: PendingWsAcknowledgement<Result> = {
    action,
    promise,
    resolve: (result) => { finish(); accepted(result); },
    reject: (error) => { finish(); refused(error); },
    timer: setTimeout(() => request.reject(timeoutError()), timeoutMs),
  };
  pending.set(key, request);
  try { send(); }
  catch (error) { request.reject(error instanceof Error ? error : new Error("发送 WebSocket 消息失败")); }
  return promise;
}
