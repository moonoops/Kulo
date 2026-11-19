import { randomUUID } from "node:crypto";
import type { DeviceChatInvitation, DevicePeerConfig, DeviceRoleTransition } from "@moco/protocol";
import { activateStagedPeer, authenticatedPeerHub, detachActivePeer, getPeerConfigPath, invalidDeviceInvitation, pairingFingerprint, stageDevicePeer, stagedPeerForAction } from "./peer-config.js";

export interface PreparedDeviceRoleChange {
  receipt: DeviceRoleTransition;
  start(): Promise<void>;
  cancel(): void;
}

interface DeviceRoleRuntime {
  configPath?: string;
  rootDir?: string;
  startHub?: () => Promise<unknown> | void;
  startPeer?: (config: DevicePeerConfig) => Promise<{ ready?: Promise<void> } | void> | void;
  onRecoveryFailure?: (error: Error) => void;
}

interface CurrentPeer {
  config: DevicePeerConfig;
  isSameHub(): Promise<boolean>;
}

function publicErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      ["local_tasks_running", "device_invitation_invalid", "device_host_unreachable"].includes(error.code)) return error.code;
}

export async function waitForPeerReady(peer: { ready?: Promise<unknown> } | void): Promise<void> {
  if (!peer?.ready) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([peer.ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("主机连接超时。")), 30_000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

/** Owned by the CLI or desktop runtime, so receipts remain available on either side of a listener swap. */
export class DeviceRoleTransitions {
  readonly #runtime: DeviceRoleRuntime;
  #current?: { key: string; change: PreparedDeviceRoleChange };
  readonly #receipts = new Map<string, { key: string; receipt: DeviceRoleTransition }>();
  #settling: Promise<void> = Promise.resolve();

  constructor(runtime: DeviceRoleRuntime) { this.#runtime = runtime; }
  get canJoin(): boolean { return Boolean(this.#runtime.startPeer); }
  get canLeave(): boolean { return Boolean(this.#runtime.startHub); }
  settled(): Promise<void> { return this.#settling; }
  lookup(id: string): DeviceRoleTransition | undefined {
    const receipt = this.#receipts.get(id)?.receipt;
    return receipt && { ...receipt };
  }

  #prepare(key: string, targetRole: DeviceRoleTransition["targetRole"], run: () => Promise<void>, requestedId?: string, resume = false): PreparedDeviceRoleChange {
    const prior = requestedId && this.#receipts.get(requestedId);
    if (prior && prior.receipt.status !== "switching" && !(resume && prior.receipt.status === "failed")) {
      if (prior.key !== key) throw Object.assign(new Error("这次切换请求与原记录不一致。"), { status: 409 });
      return { receipt: { ...prior.receipt }, start: async () => {}, cancel: () => {} };
    }
    if (this.#current?.change.receipt.status === "switching") {
      if (this.#current.key === key && (!requestedId || requestedId === this.#current.change.receipt.id)) return this.#current.change;
      throw Object.assign(new Error("正在切换运行模式，请稍后再试。"), { status: 409, code: "role_switch_busy" });
    }
    const receipt: DeviceRoleTransition = { id: requestedId ?? randomUUID(), targetRole, status: "switching" };
    let completion: Promise<void> | undefined;
    const change = { receipt, start: () => {
      if (receipt.status !== "switching") return completion ?? Promise.resolve();
      if (completion) return completion;
      completion = run().then(() => { receipt.status = "ready"; }, (error: unknown) => {
        receipt.status = "failed";
        receipt.error = error instanceof Error ? error.message : "运行模式切换失败，请重试。";
        const code = publicErrorCode(error);
        if (code) receipt.code = code;
      }).finally(() => {
        if (this.#current?.change.receipt === receipt) this.#current = undefined;
      });
      this.#settling = completion;
      return completion;
    }, cancel: () => {
      if (!completion && receipt.status === "switching") {
        receipt.status = "failed";
        receipt.error = "接入确认未能保存，请重试。";
        this.#receipts.delete(receipt.id);
        if (this.#current?.change.receipt === receipt) this.#current = undefined;
      }
    } };
    this.#current = { key, change };
    if (this.#receipts.size >= 32) this.#receipts.delete(this.#receipts.keys().next().value!);
    this.#receipts.set(receipt.id, { key, receipt });
    return change;
  }

  async #restore<T>(restore: (() => T | Promise<T>) | undefined): Promise<T> {
    if (!restore) throw new Error("未能切换运行模式，请检查本机服务后重试。");
    try { return await restore(); }
    catch {
      const failure = new Error("运行服务未能恢复，请重新打开 Moco。");
      this.#runtime.onRecoveryFailure?.(failure);
      throw failure;
    }
  }

  join(input: DeviceChatInvitation, checkTasks: () => Promise<void>, requestedId?: string, rootDir = this.#runtime.rootDir, current?: CurrentPeer): PreparedDeviceRoleChange {
    const { configPath = getPeerConfigPath() } = this.#runtime;
    const key = `${pairingFingerprint(input)}:${input.hubId ?? ""}`;
    return this.#join(key, async () => {
      let config: DevicePeerConfig;
      try { config = await stageDevicePeer({ ...input, configPath, rootDir }, requestedId, current?.config); }
      catch (error) {
        if (publicErrorCode(error)) throw error;
        throw new Error("设备配对失败，请检查接入命令和本机配置后重试。");
      }
      if (input.hubId && (await authenticatedPeerHub(config, 8_000)).hubId !== input.hubId) throw invalidDeviceInvitation();
      return config;
    }, checkTasks, requestedId, current);
  }

  resumeJoin(actionId: string, hubUrl: string, checkTasks: () => Promise<void>): PreparedDeviceRoleChange | undefined {
    const staged = stagedPeerForAction(this.#runtime.configPath ?? getPeerConfigPath(), actionId, hubUrl);
    if (staged) return this.#join(actionId, async () => staged, checkTasks, actionId, undefined, true);
  }

  canResumeJoin(actionId: string, hubUrl: string): boolean {
    return Boolean(stagedPeerForAction(this.#runtime.configPath ?? getPeerConfigPath(), actionId, hubUrl));
  }

  #join(key: string, getConfig: () => Promise<DevicePeerConfig>, checkTasks: () => Promise<void>, requestedId?: string, current?: CurrentPeer, resume = false): PreparedDeviceRoleChange {
    const { startPeer, startHub, configPath = getPeerConfigPath() } = this.#runtime;
    if (!startPeer) throw Object.assign(new Error("当前运行模式不支持接入其他主机。"), { status: 409 });
    return this.#prepare(key, "joined", async () => {
      if (current) {
        if (await current.isSameHub()) return;
        await checkTasks();
      }
      const config = await getConfig();
      await checkTasks();
      let connected = false;
      try {
        await waitForPeerReady(await startPeer(config));
        connected = true;
        activateStagedPeer(config, configPath);
      } catch {
        if (current) {
          // The old Hub may already be offline. Restore its local listener so the user can retry or leave.
          await this.#restore(() => startPeer(current.config));
        } else {
          await this.#restore(startHub);
        }
        if (connected) throw new Error("未能保存新的设备连接，已恢复原运行模式。请检查本机配置后重试。");
        const message = current ? "未能连接目标主机，已恢复原主机的本机入口。可使用原邀请重试。" : "未能连接目标主机，已恢复本机独立运行。可使用原接入命令重试。";
        throw Object.assign(new Error(message), { code: "device_host_unreachable" });
      }
    }, requestedId, resume);
  }

  leave(config: DevicePeerConfig, requestedId?: string): PreparedDeviceRoleChange {
    const { startHub, startPeer, configPath = getPeerConfigPath() } = this.#runtime;
    if (!startHub) throw Object.assign(new Error("当前运行模式不支持在线退出主机。"), { status: 409 });
    return this.#prepare("leave", "hub", async () => {
      try { await startHub(); detachActivePeer(config, configPath); }
      catch {
        const peer = await this.#restore(startPeer && (() => startPeer(config)));
        try { await waitForPeerReady(peer); }
        catch { throw new Error("未能启动本机主机。已恢复设备页面，远程主机暂时不可达，可再次断开连接。"); }
        throw new Error("未能启动本机主机，已恢复原设备连接。请重试。");
      }
    }, requestedId);
  }
}
