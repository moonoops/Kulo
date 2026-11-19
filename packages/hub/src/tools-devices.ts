import { randomBytes } from "node:crypto";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  SENSITIVE_TEXT_REDACTION,
  extractDeviceJoinMatches,
  type DeviceInterconnectionView,
  type DeviceRoleTransition,
  type DeviceSshRequest,
  type DeviceSshScan,
  type InterconnectedDevice,
  type SettingsAssistantAction,
} from "@kulo/protocol";
import type { DeviceAssistantOperation } from "./settings-doc.js";
import type { PreparedDeviceRoleChange } from "@kulo/env";
import { DEVICES_INTERCONNECTION_GUIDE } from "./prompts.js";

const JOIN_STAGING_TTL_MS = 10 * 60_000;
const MAX_STAGED_JOINS = 128;

interface StagedDeviceJoin {
  ref: string;
  hubUrl: string;
  inviteToken: string;
  expiresAt: number;
}

export class DeviceJoinStaging {
  readonly #entries = new Map<string, StagedDeviceJoin>();

  #expire(now = Date.now()): void {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(key);
    }
  }

  get hasActive(): boolean {
    this.#expire();
    return this.#entries.size > 0;
  }

  stage(hubUrl: string, inviteToken: string, now = Date.now()): StagedDeviceJoin {
    this.#expire(now);
    for (const existing of this.#entries.values()) {
      if (existing.hubUrl === hubUrl && existing.inviteToken === inviteToken) {
        existing.expiresAt = now + JOIN_STAGING_TTL_MS;
        return existing;
      }
    }
    while (this.#entries.size >= MAX_STAGED_JOINS) {
      const oldest = this.#entries.keys().next().value;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    const ref = `join_${randomBytes(8).toString("hex")}`;
    const created: StagedDeviceJoin = { ref, hubUrl, inviteToken, expiresAt: now + JOIN_STAGING_TTL_MS };
    this.#entries.set(ref, created);
    return created;
  }

  resolve(ref: string, now = Date.now()): StagedDeviceJoin {
    this.#expire(now);
    const entry = this.#entries.get(ref.trim());
    if (!entry) throw new Error("设备配对凭证不存在或已过期，请重新生成并粘贴接入命令。");
    return entry;
  }

  consume(ref: string): void {
    this.#entries.delete(ref.trim());
  }

  sealText(text: string, rememberSecrets?: (values: readonly string[]) => void): { text: string; joinRef?: string; hubUrl?: string } {
    const matches = extractDeviceJoinMatches(text);
    if (matches.length === 0) return { text };
    const tokens = Array.from(new Set(matches.map((item) => item.inviteToken)));
    rememberSecrets?.(tokens);
    let sanitized = text;
    for (let index = matches.length - 1; index >= 0; index--) {
      const match = matches[index]!;
      sanitized = `${sanitized.slice(0, match.tokenStart)}${SENSITIVE_TEXT_REDACTION}${sanitized.slice(match.tokenEnd)}`;
    }
    const first = matches[0]!;
    const ambiguous = matches.some((item) => item.hubUrl !== first.hubUrl || item.inviteToken !== first.inviteToken);
    if (ambiguous) {
      return { text: `${sanitized}\n[Multiple distinct device pairing commands detected; please paste a single invitation command]` };
    }
    const staged = this.stage(first.hubUrl, first.inviteToken);
    return {
      text: `${sanitized}\n[Device join staged: join_ref=${staged.ref} hub=${staged.hubUrl}]`,
      joinRef: staged.ref,
      hubUrl: staged.hubUrl,
    };
  }
}

export interface HubDeviceController {
  view(principalId?: string): DeviceInterconnectionView;
  setEnabled(enabled: boolean, force?: boolean): Promise<DeviceInterconnectionView>;
  rename(deviceId: string, name: string): Promise<DeviceInterconnectionView>;
  createInvitation(input: { hubUrl?: string; name?: string }): Promise<{ id: string; deviceId: string; hubUrl: string; expiresAt: number }>;
  scanSsh(input: DeviceSshRequest): Promise<DeviceSshScan>;
  addSsh(scanId: string): Promise<InterconnectedDevice | undefined>;
  removeDevice(deviceId: string, force?: boolean): Promise<void>;
  canSwitchRole(): boolean;
  joinPeer?(input: { hubUrl: string; inviteToken: string }, force: boolean, id: string): Promise<PreparedDeviceRoleChange>;
  resumeJoin?(id: string, hubUrl: string, force: boolean): Promise<PreparedDeviceRoleChange | undefined>;
  canResumeJoin?(id: string, hubUrl: string): boolean;
  roleStatus?(id: string): DeviceRoleTransition | undefined;
}

export interface DeviceAssistantHost {
  readDevices(): Promise<DeviceInterconnectionView | { unavailable: true }>;
  proposeDeviceOperation(input: {
    commandId: string;
    title: string;
    description?: string;
    changes: string[];
    operation: DeviceAssistantOperation;
    clientOperation?: SettingsAssistantAction["clientOperation"];
    autoNavigateMachines?: boolean;
  }): Promise<SettingsAssistantAction>;
  applyImmediateDeviceChange(commandId: string, run: (controller: HubDeviceController) => Promise<{
    title: string;
    changes: string[];
    result: unknown;
    pendingOperation?: { description?: string; operation: DeviceAssistantOperation };
  }>): Promise<{ action: SettingsAssistantAction; result?: unknown }>;
  resolveStagedJoin(joinRef: string): { hubUrl: string };
  openDeviceDialog(intent: "add-device" | "join-device", commandId: string): Promise<SettingsAssistantAction>;
  hasRunningLocalTasks(): Promise<boolean>;
}

export function createDeviceToolsExtension(host: () => DeviceAssistantHost) {
  const jsonResult = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

  return defineExtension({
    name: "kulo-device-tools",
    sections: [
      section("kulo_devices_guide", () => DEVICES_INTERCONNECTION_GUIDE, { tag: false }),
    ],
    tools: [
      defineTool({
        name: "kulo_devices_manage",
        description: "Manage host-side device interconnection: `enable`/`disable` interconnection, `rename` host or device, open Add Device dialog / create `invite`, or propose `remove` via user confirmation card.",
        parameters: obj({
          action: oneOf(["enable", "disable", "rename", "invite", "remove"]),
          device_id: opt(str({ description: "Target device ID for `rename` or `remove` (pass `'local'` to rename the Hub host)." })),
          name: opt(str({ description: "New device or host display name." })),
          hub_url: opt(str({ description: "Reachable Hub URL from `kulo_settings_read(section='machines')` `hubUrls` when creating an invitation." })),
        }),
        execute: async (args, api) => {
          if (args.action === "remove") {
            const deviceId = args.device_id?.trim();
            if (!deviceId || deviceId === "local") throw new Error("请指定要移除的已连接设备 ID（不能移除本机）。");
            const current = await host().readDevices();
            const target = "devices" in current ? current.devices.find((item) => item.id === deviceId) : undefined;
            const action = await host().proposeDeviceOperation({
              commandId: api.callId,
              title: `移除设备 ${target?.name ?? deviceId}`,
              description: "这台设备的执行连接和界面访问将被撤销。",
              changes: [`移除设备：${target?.name ?? deviceId} (${deviceId})`],
              operation: { kind: "device-remove", deviceId },
            });
            return jsonResult({ action });
          }
          if (args.action === "invite" && !args.hub_url?.trim()) {
            const action = await host().openDeviceDialog("add-device", api.callId);
            return jsonResult({ action, note: "已在页面打开添加设备弹窗。" });
          }
          return jsonResult(await host().applyImmediateDeviceChange(api.callId, async (controller) => {
            if (args.action === "enable") {
              const view = await controller.setEnabled(true);
              return { title: "开启设备互联", changes: ["设备互联：关闭 → 开启"], result: view };
            }
            if (args.action === "disable") {
              try {
                const view = await controller.setEnabled(false, false);
                return { title: "关闭设备互联", changes: ["设备互联：开启 → 关闭"], result: view };
              } catch (error) {
                if (error && typeof error === "object" && "code" in error && error.code === "remote_tasks_running") {
                  return {
                    title: "关闭设备互联",
                    changes: ["中断正在执行的远程任务并关闭设备互联"],
                    result: { status: "confirmation_required" },
                    pendingOperation: {
                      description: "当前有正在远程设备上执行的任务，确认关闭将中断这些远程任务（已添加设备会保留）。",
                      operation: { kind: "device-disable" },
                    },
                  };
                }
                throw error;
              }
            }
            if (args.action === "rename") {
              const deviceId = args.device_id?.trim() || "local";
              const name = args.name?.trim();
              if (!name) throw new Error("请提供新的设备或主机名称。");
              const view = await controller.rename(deviceId, name);
              return { title: `重命名${deviceId === "local" ? "主机" : "设备"}为 ${name}`, changes: [`名称 → ${name}`], result: view };
            }
            const created = await controller.createInvitation({ hubUrl: args.hub_url?.trim(), name: args.name?.trim() });
            await host().openDeviceDialog("add-device", `${api.callId}:dialog`);
            return {
              title: "已准备设备接入窗口",
              changes: [`主脑地址：${created.hubUrl}`],
              result: { id: created.id, deviceId: created.deviceId, hubUrl: created.hubUrl, expiresAt: created.expiresAt, note: "已在左侧打开添加设备窗口，用户可直接复制接入命令或给 Agent 的指令。" },
            };
          }));
        },
      }),
      defineTool({
        name: "kulo_devices_ssh_scan",
        description: "Scan a remote host's SSH fingerprint and create a user confirmation card before pairing (requires key/agent SSH access; applied only after user confirms the fingerprint).",
        parameters: obj({
          host: str({ description: "SSH host address or `~/.ssh/config` alias." }),
          port: opt(num({ description: "SSH port (default 22)." })),
          user: opt(str({ description: "Optional SSH username." })),
          name: opt(str({ description: "Optional device display name." })),
          root_dir: opt(str({ description: "Optional remote workspace directory (default `~/Kulo`)." })),
          hub_url: opt(str({ description: "Hub URL reachable from the remote machine (defaults to first LAN/Tailscale URL)." })),
        }),
        execute: async (args, api) => {
          const current = await host().readDevices();
          if ("unavailable" in current) throw new Error("当前环境不支持设备互联管理。");
          if (current.role === "joined") throw new Error("当前客户端已接入其他主机，请在主机设备上添加新设备。");
          const hubUrl = args.hub_url?.trim() || current.hubUrls[0];
          if (!hubUrl) throw new Error("未找到可供其他设备访问的本机网络地址，请检查网络连接。");
          const res = await host().applyImmediateDeviceChange(`${api.callId}:scan`, async (controller) => {
            if (!current.enabled) await controller.setEnabled(true);
            const scan = await controller.scanSsh({
              host: args.host.trim(),
              port: args.port ?? 22,
              ...(args.user?.trim() ? { user: args.user.trim() } : {}),
              ...(args.name?.trim() ? { name: args.name.trim() } : {}),
              ...(args.root_dir?.trim() ? { rootDir: args.root_dir.trim() } : {}),
              hubUrl,
            });
            return {
              title: `确认 SSH 主机指纹并接入 ${args.name?.trim() || args.host.trim()}`,
              changes: [`SSH 目标：${args.user?.trim() ? `${args.user.trim()}@` : ""}${args.host.trim()}:${args.port ?? 22}`, ...scan.fingerprints.map((fp) => `指纹：${fp}`)],
              result: { scanId: scan.scanId, fingerprints: scan.fingerprints, status: "awaiting_user_confirmation" },
              pendingOperation: {
                description: "请核对以上 SSH 主机指纹无误后确认接入。",
                operation: { kind: "device-ssh-add", scanId: scan.scanId },
              },
            };
          });
          return jsonResult(res);
        },
      }),
      defineTool({
        name: "kulo_devices_join",
        description: "Join this Kulo client as a peer to an existing Hub host: pass `join_ref` when staged from a pasted invitation to create a confirmation card, or omit `join_ref` to open the Join Existing Host dialog.",
        parameters: obj({
          join_ref: opt(str({ description: "Sealed staging reference (`join_...`) from a pasted invitation—never pass raw invite tokens." })),
        }),
        execute: async (args, api) => {
          if (!args.join_ref?.trim()) {
            const action = await host().openDeviceDialog("join-device", api.callId);
            return jsonResult({ action, note: "已在设备互联页打开「接入现有主机」弹窗，请粘贴主机生成的接入命令。" });
          }
          const staged = host().resolveStagedJoin(args.join_ref.trim());
          const hasTasks = await host().hasRunningLocalTasks();
          const action = await host().proposeDeviceOperation({
            commandId: api.callId,
            title: `接入主机 ${staged.hubUrl}`,
            description: hasTasks
              ? "本机当前有未结束的本地任务。确认接入后将停止本机独立 Hub 服务（本地历史数据保留），并切换为所选主机的从属设备。"
              : "确认后本机将作为从属设备连接至该主机，并停止本机独立 Hub 服务（本地历史数据保留，断开连接后可随时恢复）。",
            changes: [`目标主机：${staged.hubUrl}`, "运行模式：本机独立主机 → 接入远程主机（Peer）"],
            operation: { kind: "device-join", hubUrl: staged.hubUrl, joinRef: args.join_ref.trim(), force: hasTasks },
            clientOperation: "join-device",
            autoNavigateMachines: true,
          });
          return jsonResult({ action, status: "awaiting_user_confirmation" });
        },
      }),
      defineTool({
        name: "kulo_devices_leave",
        description: "When `role='joined'`, propose disconnecting from the remote Hub and restoring standalone local Hub mode via a user confirmation card.",
        parameters: obj({}),
        execute: async (_args, api) => {
          const action = await host().proposeDeviceOperation({
            commandId: api.callId,
            title: "断开当前主机并恢复独立运行",
            description: "确认后本客户端将断开与远程主机的连接，并在本机重新启动独立 Hub 服务。",
            changes: ["运行模式：接入远程主机（Peer） → 本机独立主机"],
            operation: { kind: "device-leave" },
            clientOperation: "leave-device",
            autoNavigateMachines: true,
          });
          return jsonResult({ action, status: "awaiting_user_confirmation" });
        },
      }),
    ],
  });
}
