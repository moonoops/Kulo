import { discoverLocalInstance, LocalInstanceInUseError, LocalInstanceOwner } from "@moco/env";

export class HubStateInUseError extends Error {
  constructor(readonly stateDir: string) { super("这份 Moco 数据已在运行。使用 open 可以打开已有的 Moco。"); }
}

export const HubStateOwner = {
  acquire(directory: string): LocalInstanceOwner {
    try { return LocalInstanceOwner.acquire({ directory, name: "hub" }, "Moco Hub 已在运行。"); }
    catch (error) {
      if (error instanceof LocalInstanceInUseError) throw new HubStateInUseError(error.directory);
      throw error;
    }
  },
};
export type HubStateOwner = LocalInstanceOwner;

export async function findRunningHub(stateDir: string, token?: string, timeoutMs?: number): Promise<URL | undefined> {
  const existing = await discoverLocalInstance({ directory: stateDir, name: "hub" }, "/api/health", token, timeoutMs);
  return existing?.url;
}
