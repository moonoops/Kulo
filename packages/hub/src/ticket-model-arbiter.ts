import type { RolePreset, RoleThinkingEffort, ThinkingEffort, TicketRecord } from "@kulo/protocol";

export interface WorkerModelSelection {
  provider?: string;
  modelId: string;
  thinkingLevel: ThinkingEffort;
}

export type WorkerModelSource = "user_override" | "escalation" | "role_preset" | "default";

export interface ResolvedWorkerModel {
  provider?: string;
  modelId: string;
  thinkingLevel: ThinkingEffort;
  /** False only when thinking stays deferred to rolePreset `"auto"` with no override or escalation thinking. */
  explicitThinking: boolean;
  source: WorkerModelSource;
}

export interface ResolveWorkerEffectiveModelInput {
  ticket: Pick<
    TicketRecord,
    "providerOverride" | "modelOverride" | "thinkingOverride" | "modelEscalation"
  > & {
    runEpoch?: number;
  };
  rolePreset?: Pick<RolePreset, "provider" | "modelId" | "thinkingLevel">;
  defaultModel: WorkerModelSelection;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveThinkingChoice(input: {
  ticketThinking?: RoleThinkingEffort;
  escalationThinking?: RoleThinkingEffort;
  roleThinking?: RoleThinkingEffort;
  defaultThinking: ThinkingEffort;
}): { thinkingLevel: ThinkingEffort; explicitThinking: boolean } {
  const { ticketThinking, escalationThinking, roleThinking, defaultThinking } = input;
  if (ticketThinking !== undefined) {
    if (ticketThinking === "auto") {
      return { thinkingLevel: defaultThinking, explicitThinking: false };
    }
    return { thinkingLevel: ticketThinking, explicitThinking: true };
  }
  if (escalationThinking !== undefined && escalationThinking !== "auto") {
    return { thinkingLevel: escalationThinking, explicitThinking: true };
  }
  if (roleThinking === "auto") {
    return { thinkingLevel: defaultThinking, explicitThinking: false };
  }
  if (roleThinking !== undefined) {
    return { thinkingLevel: roleThinking, explicitThinking: true };
  }
  return { thinkingLevel: defaultThinking, explicitThinking: true };
}

/**
 * Single authoritative Worker model arbiter (§2.4).
 *
 * Strict precedence:
 *   1. User explicit override (`ticket.providerOverride` / `ticket.modelOverride`)
 *   2. Active unidirectional escalation (`ticket.modelEscalation`, bound to `ticket.runEpoch`)
 *   3. Role preset (`rolePreset.provider` / `rolePreset.modelId`)
 *   4. Global default model (`defaultModel.provider` / `defaultModel.modelId`)
 */
export function resolveWorkerEffectiveModel(
  input: ResolveWorkerEffectiveModelInput,
): ResolvedWorkerModel {
  const { ticket, rolePreset, defaultModel } = input;
  const userProvider = cleanString(ticket.providerOverride);
  const userModel = cleanString(ticket.modelOverride);
  const roleProvider = cleanString(rolePreset?.provider);
  const roleModel = cleanString(rolePreset?.modelId);
  const defaultProvider = cleanString(defaultModel.provider);
  const fallbackModelId = defaultModel.modelId.trim();

  if (userProvider || userModel) {
    const thinking = resolveThinkingChoice({
      ticketThinking: ticket.thinkingOverride,
      roleThinking: rolePreset?.thinkingLevel,
      defaultThinking: defaultModel.thinkingLevel,
    });
    return {
      provider: userProvider ?? roleProvider ?? defaultProvider,
      modelId: userModel ?? roleModel ?? fallbackModelId,
      thinkingLevel: thinking.thinkingLevel,
      explicitThinking: thinking.explicitThinking,
      source: "user_override",
    };
  }

  const escalation = ticket.modelEscalation;
  const escalationModel = cleanString(escalation?.escalatedModel?.modelId);
  const escalationActive = Boolean(
    escalation &&
      escalationModel &&
      (ticket.runEpoch === undefined || escalation.runEpoch === ticket.runEpoch),
  );
  if (escalationActive && escalation && escalationModel) {
    const escalationProvider = cleanString(escalation.escalatedModel.provider);
    const thinking = resolveThinkingChoice({
      ticketThinking: ticket.thinkingOverride,
      escalationThinking: escalation.escalatedModel.thinkingLevel,
      roleThinking: rolePreset?.thinkingLevel,
      defaultThinking: defaultModel.thinkingLevel,
    });
    return {
      provider: escalationProvider ?? roleProvider ?? defaultProvider,
      modelId: escalationModel,
      thinkingLevel: thinking.thinkingLevel,
      explicitThinking: thinking.explicitThinking,
      source: "escalation",
    };
  }

  if (roleProvider || roleModel) {
    const thinking = resolveThinkingChoice({
      ticketThinking: ticket.thinkingOverride,
      roleThinking: rolePreset?.thinkingLevel,
      defaultThinking: defaultModel.thinkingLevel,
    });
    return {
      provider: roleProvider ?? defaultProvider,
      modelId: roleModel ?? fallbackModelId,
      thinkingLevel: thinking.thinkingLevel,
      explicitThinking: thinking.explicitThinking,
      source: "role_preset",
    };
  }

  const thinking = resolveThinkingChoice({
    ticketThinking: ticket.thinkingOverride,
    roleThinking: rolePreset?.thinkingLevel,
    defaultThinking: defaultModel.thinkingLevel,
  });
  return {
    provider: defaultProvider,
    modelId: fallbackModelId,
    thinkingLevel: thinking.thinkingLevel,
    explicitThinking: thinking.explicitThinking,
    source: "default",
  };
}
