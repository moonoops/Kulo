import type {
  AgentExpressionState,
  ChatAttachment,
  ChatDisplayItem,
  ChatReplyReference,
  EnvNodeDescriptor,
  LiveStreamState,
  KuloSettingsView,
  SlotSummary,
  TicketCardView,
  TicketClosureKind,
  TicketRecord,
  TopicSummary,
  TopicActivity,
} from "./domain.js";
import type { TicketBoardDelta } from "./ticket-board.js";
import type { SettingsAssistantContext, SettingsAssistantDecision, SettingsAssistantSnapshot } from "./settings-assistant.js";
import type { UiCardSnapshot } from "./genui.js";
import type { ProjectView, ProjectEnvRequest, ProjectDirectoryListing, ProjectDirectoryGrant, StagedWorkspacePrepareResult } from "./projects.js";
import type { BrowserRequest, BrowserResult, CapabilitiesWorkspaceSnapshot } from "./capabilities.js";
import type { VoiceSnapshot } from "./voice.js";
import type { ComputerUseRequest, ComputerUseResult } from "./computer-use.js";
import type { ComputerPreviewTarget, ComputerPreviewUpdate } from "./computer-preview.js";

// ============================================================================
// Client <-> Hub WebSocket Protocol (/ws/client)
// ============================================================================

export type ClientToHubMessage =
  | { type: "settings.assistant.subscribe"; context: SettingsAssistantContext; requestId?: string }
  | { type: "settings.assistant.context"; context: SettingsAssistantContext; requestId?: string }
  | { type: "settings.assistant.send"; content: string; context: SettingsAssistantContext; attachments?: ChatAttachment[]; expectedTopicId?: string | null; requestId?: string }
  | { type: "settings.assistant.abort"; expectedTopicId?: string | null; requestId?: string }
  | { type: "settings.assistant.new"; expectedTopicId: string | null; requestId?: string }
  | { type: "settings.assistant.select"; topicId: string; expectedTopicId: string | null; requestId?: string }
  | { type: "settings.assistant.delete"; topicId: string; expectedTopicId: string | null; requestId?: string }
  | { type: "settings.assistant.action"; actionId: string; decision: SettingsAssistantDecision; clientId: string; error?: string; expectedTopicId?: string | null; requestId?: string }
  | {
      type: "topic.select";
      topicId: string;
      selectionVersion?: number;
      requestId?: string;
    }
  | {
      type: "chat.send";
      content: string;
      replyTo?: ChatReplyReference;
      attachments?: ChatAttachment[];
      topicId?: string;
      requestId?: string;
      whenBusy?: "steer" | "followUp";
      targetDeviceId?: string;
    }
  | {
      type: "chat.abort";
      topicId?: string;
      requestId?: string;
    }
  | {
      type: "chat.retry";
      topicId?: string;
      requestId?: string;
    }
  | {
      type: "ticket.steer";
      ticketId: string;
      text: string;
      replyTo?: ChatReplyReference;
      attachments?: ChatAttachment[];
      commandId?: string;
    }
  | {
      type: "ticket.retry";
      ticketId: string;
      commandId?: string;
    }
  | {
      type: "ticket.stop";
      ticketId: string;
      reason?: string;
      commandId?: string;
    }
  | {
      type: "ticket.close";
      ticketId: string;
      kind: TicketClosureKind;
      reason: string;
      replacementTicketId?: string;
      commandId?: string;
    }
  | {
      type: "schedule.stop";
      ticketId: string;
      commandId?: string;
    }
  | {
      type: "schedule.delete";
      ticketId: string;
      commandId?: string;
    }
  | {
      type: "ticket.inspect";
      ticketId: string;
      requestId?: string;
    }
  | { type: "client.ping"; requestId?: string }
  | {
      type: "state.sync";
      requestId?: string;
    };

export type ClientWsActionType = ClientToHubMessage["type"];

export type HubToClientMessage =
  | { type: "hub.capabilities"; snapshot: CapabilitiesWorkspaceSnapshot }
  | { type: "hub.voice"; snapshot: VoiceSnapshot }
  | { type: "hub.ui_card"; card: UiCardSnapshot }
  | { type: "hub.settings_assistant"; snapshot: SettingsAssistantSnapshot; requestId?: string }
  | {
      type: "hub.snapshot";
      deliveryIdentity?: { hubId: string; principalId: string };
      supportsPing?: boolean;
      selectionVersion?: number;
      activeTopicId: string;
      topics: TopicSummary[];
      messages: ChatDisplayItem[];
      topicActivities?: Record<string, TopicActivity>;
      historyBefore?: number;
      live: LiveStreamState;
      tickets: TicketCardView[];
      ticketRevision?: number;
      slots: SlotSummary;
      envs: EnvNodeDescriptor[];
      projects?: ProjectView[];
      expression?: AgentExpressionState | null;
      settings?: KuloSettingsView;
    }
  | {
      type: "hub.topics";
      topics: TopicSummary[];
    }
  | { type: "hub.projects"; projects: ProjectView[] }
  | { type: "hub.topic_activity"; topicId: string; activity: TopicActivity }
  | {
      type: "hub.live";
      topicId?: string;
      selectionVersion?: number;
      live: LiveStreamState;
    }
  | {
      type: "hub.messages";
      topicId?: string;
      selectionVersion?: number;
      messages: ChatDisplayItem[];
      historyBefore?: number;
    }
  | {
      type: "hub.tickets";
      tickets: TicketCardView[];
      slots: SlotSummary;
    }
  | ({ type: "hub.ticket_delta" } & TicketBoardDelta)
  | {
      type: "hub.envs";
      envs: EnvNodeDescriptor[];
    }
  | {
      type: "hub.expression";
      expression: AgentExpressionState | null;
    }
  | {
      type: "hub.settings";
      settings: KuloSettingsView;
    }
  | {
      type: "hub.ticket_detail";
      ticket: TicketRecord;
      transcript: ChatDisplayItem[];
      live: LiveStreamState;
    }
  | {
      type: "hub.ack";
      action: ClientWsActionType;
      requestId?: string;
      commandId?: string;
      topicId?: string;
      ticketId?: string;
      deduplicated?: boolean;
      submissionId?: number;
      delivery?: "queued" | "accepted";
    }
  | {
      type: "hub.error";
      message: string;
      code?: string;
      status?: number;
      retryable?: boolean;
      action?: ClientWsActionType;
      requestId?: string;
      commandId?: string;
      topicId?: string;
      ticketId?: string;
    };

// ============================================================================
// Env Daemon Agent <-> Hub Reverse-Tunnel Protocol (/ws/env)
// ============================================================================

export const STREAM_RESUME_CAPABILITY = "stream-resume-v1" as const;
export const STREAM_RESUME_GRACE_MS = 20_000;
export const STREAM_UNACKED_MAX_BYTES = 8 * 1024 * 1024;
export const DEVICE_UNACKED_MAX_BYTES = 32 * 1024 * 1024;

export interface StreamResumeState {
  streamId: number;
  rxSeq: number;
}

export type EnvToHubControlMessage =
  | { type: "env.external_agent_result"; requestId: string; result?: import("./external-agents.js").ExternalAgentResponse; error?: string }
  | { type: "env.external_agent_tool_request"; requestId: string; runId: string; taskId: string; runEpoch: number; cwd: string; allowSubagents: boolean; name: string; args: Record<string, unknown> }
  | { type: "env.computer_preview"; subscriptionId: string; update: ComputerPreviewUpdate }
  | { type: "env.android_status"; status: import("./android.js").AndroidEnvStatus }
  | { type: "env.android_result"; requestId: string; result: import("./android.js").AndroidResult }
  | { type: "env.android_control_result"; requestId: string; result: import("./android.js").AndroidControlResult }
  | { type: "env.notification_classify"; request: import("./android-notifications.js").AndroidNotificationClassification }
  | { type: "env.notification_cancel"; requestId: string; bindingId: string }
  | { type: "env.computer_result"; requestId: string; result?: ComputerUseResult; error?: string }
  | { type: "env.browser_result"; requestId: string; result?: BrowserResult; error?: string }
  | {
      type: "env.project_result";
      requestId: string;
      result?:
        | ProjectDirectoryListing
        | ProjectDirectoryGrant
        | { cleanupPending: boolean }
        | StagedWorkspacePrepareResult
        | import("./external-agents.js").StagedWorkspaceDiffDetail
        | import("./external-agents.js").StagedWorkspaceApplyResult
        | { discarded: boolean };
      error?: string;
      errorCode?: string;
    }
  | {
      type: "env.register";
      envId: string;
      name: string;
      rootDir: string;
      platform: string;
      arch: string;
      executionKind?: "pi-env" | "native-device";
      connectionLease?: string;
      capabilities: string[];
      token?: string;
      info?: import("./devices.js").DeviceSystemInfo;
      /** Last Hub instance ID observed by this Env, used to validate stream-resume-v1 continuity. */
      hubInstanceId?: string;
      /** Streams still held open during the 20s reconnect grace window with their highest contiguous rxSeq. */
      activeStreams?: StreamResumeState[];
    }
  | {
      type: "env.stream_ready";
      streamId: number;
    }
  | {
      type: "env.stream_ack";
      streamId: number;
      rxSeq: number;
    }
  | {
      type: "env.stream_closed";
      streamId: number;
      code?: number | null;
      error?: string;
    }
  | {
      type: "env.pong";
      ts: number;
    };

export type HubToEnvControlMessage =
  | { type: "hub.external_agent_request"; requestId: string; request: import("./external-agents.js").ExternalAgentRequest }
  | { type: "hub.external_agent_tool_result"; requestId: string; runId: string; taskId: string; runEpoch: number; result?: unknown; error?: string }
  | { type: "hub.computer_preview_subscribe"; subscriptionId: string; target: ComputerPreviewTarget }
  | { type: "hub.computer_preview_unsubscribe"; subscriptionId: string }
  | { type: "hub.android_request"; requestId: string; budgetMs: number; request: import("./android.js").AndroidRequest }
  | { type: "hub.android_cancel"; requestId: string; request: import("./android.js").AndroidCancel }
  | { type: "hub.notification_decision"; result: import("./android-notifications.js").AndroidNotificationClassificationResult }
  | { type: "hub.computer_request"; requestId: string; request: ComputerUseRequest }
  | { type: "hub.computer_cancel"; requestId: string }
  | { type: "hub.browser_request"; requestId: string; request: BrowserRequest }
  | { type: "hub.project_request"; requestId: string; request: ProjectEnvRequest }
  | {
      type: "hub.registered";
      envId: string;
      /** Unique Hub runtime instance identifier for stream-resume-v1 validation. */
      hubInstanceId?: string;
      /** True when stream-resume-v1 sequenced binary framing and 20s resume were negotiated. */
      streamResumeSupported?: boolean;
      /** Streams accepted for seamless resume with Hub's highest contiguous rxSeq from Env. */
      resumedStreams?: StreamResumeState[];
      /** Stream IDs that Env must terminate immediately (revoked, stopped, expired, or Hub restarted). */
      closeStreams?: number[];
    }
  | {
      type: "hub.open_stream";
      streamId: number;
      daemonToken: string;
      projectId?: string;
      grantRevision?: number;
      stagedTaskId?: string;
      readOnly?: boolean;
      workspaceDir?: string;
      scratchDir?: string;
      protectedPaths?: string[];
      network?: { localConnectPorts?: number[]; localListenPorts?: number[]; offline?: boolean };
    }
  | {
      type: "hub.stream_ack";
      streamId: number;
      rxSeq: number;
    }
  | {
      type: "hub.close_stream";
      streamId: number;
    }
  | {
      type: "hub.ping";
      ts: number;
    };

export function encodeStreamChunk(streamId: number, chunk: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(streamId >>> 0, 0);
  return Buffer.concat([header, chunk]);
}

export function decodeStreamChunk(raw: Buffer | Uint8Array): {
  streamId: number;
  payload: Buffer;
} {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.byteLength < 4) {
    throw new Error(`Invalid binary stream frame length: ${buf.byteLength}`);
  }
  const streamId = buf.readUInt32BE(0);
  const payload = buf.subarray(4);
  return { streamId, payload };
}

export function encodeSequencedStreamChunk(streamId: number, seq: number, chunk: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(streamId >>> 0, 0);
  header.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([header, chunk]);
}

export function decodeSequencedStreamChunk(raw: Buffer | Uint8Array): {
  streamId: number;
  seq: number;
  payload: Buffer;
} {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.byteLength < 8) {
    throw new Error(`Invalid sequenced binary stream frame length: ${buf.byteLength}`);
  }
  const streamId = buf.readUInt32BE(0);
  const seq = buf.readUInt32BE(4);
  const payload = buf.subarray(8);
  return { streamId, seq, payload };
}
