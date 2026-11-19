import { describeKuloError, type FriendlyErrorDescriptor, type FriendlyErrorInput, type FriendlyErrorKind } from "@kulo/protocol";
import { getLanguage } from "./kulo-i18n";

export function describeLocalizedKuloError(input: FriendlyErrorInput): FriendlyErrorDescriptor {
  const error = describeKuloError(input);
  if (getLanguage() !== "en") return error;

  const model = input.modelId?.trim();
  const messages: Record<FriendlyErrorKind, Pick<FriendlyErrorDescriptor, "title" | "hint">> = {
    user_abort: {
      title: "Generation stopped",
      hint: "This reply was stopped manually.",
    },
    upstream_disabled: {
      title: "Upstream model unavailable",
      hint: model
        ? `The gateway's upstream account or channel for “${model}” is disabled or unavailable. Choose another model in Models, or check the gateway's upstream channels.`
        : "The gateway's upstream account or channel is disabled or unavailable. Choose another model in Models, or check the gateway's upstream channels.",
    },
    auth: {
      title: "Model authentication failed",
      hint: "The API key is missing, invalid, or expired. Update it in Models, then retry.",
    },
    quota: {
      title: "Model quota or account balance exhausted",
      hint: "The gateway account or API key has no remaining quota. Add credit, replace the key, or choose another model in Models.",
    },
    forbidden: {
      title: "Model service denied the request",
      hint: "The gateway or upstream access policy blocked this request. Check model permissions or choose another model in Models.",
    },
    model_not_found: {
      title: "Configured model not found",
      hint: model
        ? `The gateway does not support or enable “${model}”, or its URL is incorrect. Test the connection and choose an available model in Models.`
        : "The gateway does not support the selected model, or its URL is incorrect. Test the connection and choose an available model in Models.",
    },
    multimodal_unsupported: {
      title: "This model does not support images",
      hint: "The selected model cannot process image input. Choose a model with image support in Models, then retry.",
    },
    context_overflow: {
      title: "Conversation exceeds the model's context limit",
      hint: "This topic's messages or attachments exceed the model's context window. Start a new topic or choose a model with a larger context window.",
    },
    rate_limit: {
      title: "Too many model requests",
      hint: "The model channel reached its rate or concurrency limit. Wait a moment, then retry.",
    },
    gateway_unavailable: {
      title: "Model gateway unavailable or timed out",
      hint: "The model gateway could not be reached reliably, or the upstream response timed out. Retry shortly. If this continues, check the gateway URL and network in Models.",
    },
    turn_limit: {
      title: "Execution step limit reached",
      hint: "This turn paused automatically to avoid repeated tool calls. Select Continue to resume.",
    },
    interrupted: {
      title: "Reply interrupted",
      hint: "Execution was interrupted or the service restarted before this turn finished. Select Retry to continue.",
    },
    unknown: error.suggestModelSettings ? {
      title: "The model could not complete the reply",
      hint: "The model service returned an unexpected response. Retry, or open diagnostics to check the gateway and model settings.",
    } : {
      title: "Could not complete the operation",
      hint: "The request could not be completed. Try again shortly.",
    },
  };

  return { ...error, ...messages[error.kind] };
}
