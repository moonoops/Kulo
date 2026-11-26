import { describe, expect, it } from "vitest";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import {
  isOrchestratorComputerEnvUsable,
  resolveOrchestratorDefaultCwd,
  selectOrchestratorDefaultEnv,
} from "../packages/hub/src/orchestrator-env-cwd.js";

function makeEnv(id: string, overrides: Partial<EnvNodeDescriptor> = {}): EnvNodeDescriptor {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "reverse-ws",
    executionKind: "pi-env",
    online: true,
    platform: "linux",
    arch: "arm64",
    rootDir: `/workspaces/${id}`,
    capabilities: ["worker-isolation", "trusted-host-v1"],
    connectedAt: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

describe("orchestrator default environment selection and remote CWD resolution", () => {
  const hostWorkspace = "/Users/host/Library/Application Support/Kulo/workspace";

  it("keeps host mainWorkspaceDir when resolved node is the local Hub environment", () => {
    const local = makeEnv("local", { platform: "darwin", rootDir: hostWorkspace });
    const selected = selectOrchestratorDefaultEnv({
      listEnvs: () => [local],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => (id === "local" ? local : undefined),
      pickDefaultEnvId: () => "local",
      targetCwd: hostWorkspace,
      mainWorkspaceDir: hostWorkspace,
      activeSettings: false,
      hubTrustMode: "sandboxed",
    });
    expect(selected?.activeEnvId).toBe("local");
    expect(selected?.cwd).toBe(hostWorkspace);
  });

  it("remaps unbound host mainWorkspaceDir to remote envRootDir when single remote container is online (both eager and lazy)", () => {
    let online = true;
    const remote = () => makeEnv("shellbench-env", { online, rootDir: "/app" });
    const eager = selectOrchestratorDefaultEnv({
      listEnvs: () => [remote()],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => (id === "shellbench-env" ? remote() : undefined),
      pickDefaultEnvId: () => "shellbench-env",
      targetCwd: `${hostWorkspace}/`,
      mainWorkspaceDir: hostWorkspace,
      activeSettings: false,
      hubTrustMode: "sandboxed",
    });
    expect(eager?.activeEnvId).toBe("shellbench-env");
    expect(eager?.cwd).toBe("/app");

    online = false;
    const whileOffline = selectOrchestratorDefaultEnv({
      listEnvs: () => [remote()],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => (id === "shellbench-env" ? remote() : undefined),
      pickDefaultEnvId: () => "shellbench-env",
      targetCwd: hostWorkspace,
      mainWorkspaceDir: hostWorkspace,
      activeSettings: false,
      hubTrustMode: "sandboxed",
    });
    expect(whileOffline?.activeEnvId).toBeUndefined();
    online = true;
    expect(whileOffline?.resolveLazy("sandboxed")).toEqual({ envId: "shellbench-env", cwd: "/app" });
    // When pickDefaultEnvId throws (e.g. descriptor-only mock with no live transport), keep activeEnvId undefined so lazyProjectEnvironment is used
    const descriptorOnly = selectOrchestratorDefaultEnv({
      listEnvs: () => [makeEnv("fixture-computer", { online: true, rootDir: "/srv/fixture" })],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => (id === "fixture-computer" ? makeEnv("fixture-computer", { online: true, rootDir: "/srv/fixture" }) : undefined),
      pickDefaultEnvId: () => { throw new Error("No execution environment registered"); },
      targetCwd: hostWorkspace,
      mainWorkspaceDir: hostWorkspace,
      activeSettings: true,
      hubTrustMode: "sandboxed",
    });
    expect(descriptorOnly?.activeEnvId).toBeUndefined();
    expect(descriptorOnly?.candidateEnv.id).toBe("fixture-computer");
  });

  it("preserves explicit custom targetCwd and avoids arbitrary remap across multiple online computers unless topicTargetDeviceId is set", () => {
    expect(
      resolveOrchestratorDefaultCwd({
        targetCwd: "/app/packages/api",
        mainWorkspaceDir: hostWorkspace,
        localEnvId: "local",
        resolvedEnvId: "shellbench-env",
        envRootDir: "/app",
        onlineComputerCount: 1,
      }),
    ).toBe("/app/packages/api");

    const local = makeEnv("local", { platform: "darwin", rootDir: hostWorkspace });
    const remoteA = makeEnv("remote-a", { rootDir: "/srv/a" });
    const remoteB = makeEnv("remote-b", { rootDir: "/srv/b" });
    const byId = new Map([local, remoteA, remoteB].map((e) => [e.id, e]));

    // Ambiguous multi-remote without topicTargetDeviceId does NOT blindly remap
    expect(
      resolveOrchestratorDefaultCwd({
        targetCwd: hostWorkspace,
        mainWorkspaceDir: hostWorkspace,
        localEnvId: "local",
        resolvedEnvId: "remote-a",
        envRootDir: "/srv/a",
        onlineComputerCount: 2,
      }),
    ).toBe(hostWorkspace);

    // Explicit topicTargetDeviceId selects remote-b and remaps default host CWD to /srv/b
    const targeted = selectOrchestratorDefaultEnv({
      listEnvs: () => [local, remoteA, remoteB],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => byId.get(id),
      pickDefaultEnvId: () => "local",
      targetCwd: hostWorkspace,
      mainWorkspaceDir: hostWorkspace,
      topicTargetDeviceId: "remote-b",
      activeSettings: false,
      hubTrustMode: "sandboxed",
    });
    expect(targeted?.activeEnvId).toBe("remote-b");
    expect(targeted?.cwd).toBe("/srv/b");
  });

  it("filters out no-sandbox and SSH nodes in sandboxed mode so pure chat turns do not crash", () => {
    const noSandboxWs = makeEnv("legacy-peer", { capabilities: ["worker-isolation-unavailable"] });
    const sshPeer = makeEnv("ssh-box", { kind: "ssh", capabilities: [] });
    expect(
      isOrchestratorComputerEnvUsable(noSandboxWs, {
        hubTrustMode: "sandboxed",
        activeSettings: false,
        isLocal: false,
      }),
    ).toBe(false);
    expect(
      isOrchestratorComputerEnvUsable(sshPeer, {
        hubTrustMode: "sandboxed",
        activeSettings: false,
        isLocal: false,
      }),
    ).toBe(false);
    expect(
      isOrchestratorComputerEnvUsable(sshPeer, {
        hubTrustMode: "trusted",
        activeSettings: false,
        isLocal: false,
      }),
    ).toBe(true);

    const none = selectOrchestratorDefaultEnv({
      listEnvs: () => [noSandboxWs, sshPeer],
      localEnvId: "local",
      isLocalEnv: (id) => id === "local",
      getEnvDescriptor: (id) => (id === "legacy-peer" ? noSandboxWs : sshPeer),
      pickDefaultEnvId: () => "legacy-peer",
      targetCwd: hostWorkspace,
      mainWorkspaceDir: hostWorkspace,
      activeSettings: false,
      hubTrustMode: "sandboxed",
    });
    expect(none).toBeUndefined();
  });
});
