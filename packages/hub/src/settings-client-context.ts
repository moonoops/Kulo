import type { JsonObject } from "@earendil-works/pi-durable";
import {
  validateAppearanceCustomization,
  type ChatAttachment,
  type DeviceInterconnectionView,
  type EnvNodeDescriptor,
  type SettingsAssistantContext,
  type SettingsAssistantModule,
} from "@kulo/protocol";
import type { ChatMessageSource } from "./chat-submissions.js";
import { KuloUserEntry } from "./ui-cards.js";

const SETTINGS_MODULES: readonly SettingsAssistantModule[] = [
  "appearance",
  "models",
  "workers",
  "identity",
  "machines",
  "capabilities",
  "connections",
  "permissions",
  "schedules",
  "archives",
];

export interface SettingsDeviceSummary {
  id: string;
  name: string;
  kind: "computer" | "android";
  isHub: boolean;
}

export interface SettingsHubSummary {
  id: string;
  name: string;
}

export function validateSettingsContextInput(raw: SettingsAssistantContext): SettingsAssistantContext {
  if (
    !raw ||
    !SETTINGS_MODULES.some((module) => module === raw.module) ||
    typeof raw.hasUnsavedChanges !== "boolean" ||
    !["system", "light", "dark"].includes(raw.appearance) ||
    typeof raw.clientId !== "string" ||
    !raw.clientId.trim() ||
    raw.clientId.length > 120
  ) {
    throw new Error("无效的设置助手页面上下文。");
  }
  if (
    (raw.active !== undefined && typeof raw.active !== "boolean") ||
    (raw.pageGeneration !== undefined && (!Number.isSafeInteger(raw.pageGeneration) || raw.pageGeneration < 1))
  ) {
    throw new Error("无效的设置页面状态。");
  }
  if (
    raw.target &&
    (![
      "capability",
      "skill",
      "connection",
      "extension",
      "external-agent",
    ].includes(raw.target.kind) ||
      typeof raw.target.id !== "string" ||
      !raw.target.id.trim() ||
      raw.target.id.length > 200)
  ) {
    throw new Error("无效的配置目标。");
  }
  return {
    module: raw.module,
    hasUnsavedChanges: raw.hasUnsavedChanges,
    appearance: raw.appearance,
    clientId: raw.clientId,
    ...(raw.active !== undefined ? { active: raw.active } : {}),
    ...(raw.pageGeneration !== undefined ? { pageGeneration: raw.pageGeneration } : {}),
    ...(raw.appearanceCustomization !== undefined
      ? {
          appearanceCustomization:
            raw.appearanceCustomization === null ? null : validateAppearanceCustomization(raw.appearanceCustomization),
        }
      : {}),
    ...(raw.target ? { target: { ...raw.target } } : {}),
  };
}

export function resolveSettingsDeviceContext(input: {
  principalId?: string;
  deviceView?: DeviceInterconnectionView;
  envs: readonly EnvNodeDescriptor[];
}): { sourceDevice?: ChatMessageSource; hubHost?: SettingsHubSummary; isHubClient?: boolean } {
  const { principalId, deviceView, envs } = input;
  const localEnv = envs.find((env) => env.kind === "local");
  const hubId = deviceView?.primaryNodeId ?? localEnv?.id ?? "local";
  const hubName = deviceView?.hubName ?? localEnv?.name ?? "主脑";
  const hubHost: SettingsHubSummary = { id: hubId, name: hubName };

  const resolvedId = principalId?.trim() || deviceView?.currentDeviceId;
  if (!resolvedId) return { hubHost };

  const isHubClient = deviceView
    ? deviceView.role === "hub" && (resolvedId === "local" || resolvedId === deviceView.currentDeviceId || resolvedId === hubId)
    : resolvedId === "local" || resolvedId === hubId;
  const deviceEntry = deviceView?.devices.find((d) => d.id === resolvedId);
  const envEntry = envs.find((e) => e.id === resolvedId) ?? (isHubClient ? localEnv : undefined);
  const kind: "computer" | "android" = envEntry?.executionKind === "native-device" ? "android" : "computer";
  const name = deviceEntry?.name ?? envEntry?.name ?? (isHubClient ? hubName : resolvedId);
  const canonicalId = isHubClient ? hubId : resolvedId;
  return {
    sourceDevice: { deviceId: canonicalId, name, kind },
    hubHost,
    isHubClient,
  };
}

export function buildSettingsUserEntry(input: {
  text: string;
  attachments: readonly ChatAttachment[];
  source?: ChatMessageSource;
  requestId?: string;
  createdAt?: number;
}) {
  return {
    kind: KuloUserEntry.kind,
    data: {
      kuloContentVersion: 1,
      text: input.text,
      attachments: JSON.parse(JSON.stringify(input.attachments)) as ChatAttachment[],
      ...(input.source ? { source: input.source } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      createdAt: input.createdAt ?? Date.now(),
    } as unknown as JsonObject,
  };
}

export function formatSettingsPromptContext(input: {
  context: SettingsAssistantContext;
  appearance: SettingsAssistantContext["appearance"];
  deviceView?: DeviceInterconnectionView;
  envs: readonly EnvNodeDescriptor[];
}): string {
  const { context, appearance, deviceView, envs } = input;
  const { sourceDevice, hubHost, isHubClient } = resolveSettingsDeviceContext({
    deviceView,
    envs,
  });
  const clientDevice: SettingsDeviceSummary | undefined = sourceDevice
    ? {
        id: sourceDevice.deviceId,
        name: sourceDevice.name,
        kind: sourceDevice.kind,
        isHub: isHubClient ?? (hubHost ? sourceDevice.deviceId === hubHost.id : false),
      }
    : undefined;
  return JSON.stringify({
    module: context.module,
    ...(context.target ? { target: context.target } : {}),
    appearance,
    ...(clientDevice ? { clientDevice } : {}),
    ...(hubHost ? { hubHost } : {}),
  });
}
