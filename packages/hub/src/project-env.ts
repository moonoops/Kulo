import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Hub-only tools remain usable while the project's device or directory is unavailable. */
export function lazyProjectEnvironment(
  id: string,
  cwd: string,
  resolve: () => Promise<ExecutionEnv>,
): ExecutionEnv {
  return new Proxy({ id, cwd } as ExecutionEnv, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== "string" || property === "then") return undefined;
      return async (...args: unknown[]) => {
        const environment = await resolve();
        const method = Reflect.get(environment, property);
        if (typeof method !== "function") throw new Error(`Unknown project environment operation: ${property}`);
        return Reflect.apply(method, environment, args);
      };
    },
  });
}
