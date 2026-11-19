export type FriendlyErrorKind =
  | "user_abort"
  | "upstream_disabled"
  | "auth"
  | "quota"
  | "forbidden"
  | "model_not_found"
  | "multimodal_unsupported"
  | "context_overflow"
  | "rate_limit"
  | "gateway_unavailable"
  | "turn_limit"
  | "interrupted"
  | "unknown";

export interface FriendlyErrorInput {
  reason?: string;
  detail?: string;
  rawMessage?: string;
  modelId?: string;
}

export interface FriendlyErrorDescriptor {
  kind: FriendlyErrorKind;
  title: string;
  hint: string;
  statusCode?: number;
  rawDetail?: string;
  retryable: boolean;
  suggestModelSettings: boolean;
  isUserAbort: boolean;
}

/** Mask API keys, bearer tokens, and key parameters from error diagnostics. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-••••")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, "Bearer ••••")
    .replace(/("api[_-]?key"\s*:\s*")[^"]+(")/gi, "$1••••$2")
    .replace(/(api[_-]?key=)[^\s&"']+/gi, "$1••••");
}

interface ParsedUpstreamLayer {
  statusCode?: number;
  message?: string;
  errorType?: string;
  errorCode?: string;
}

function parseJsonObjectSafe(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const sliced = JSON.parse(trimmed.slice(start, end + 1));
        if (sliced && typeof sliced === "object" && !Array.isArray(sliced)) {
          return sliced as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseSingleErrorLayer(raw: string): ParsedUpstreamLayer {
  let statusCode: number | undefined;
  let body = raw.trim();

  const prefixMatch = /^(\d{3})\s*[:：\-]?\s*([\s\S]*)$/.exec(body);
  if (prefixMatch) {
    const code = Number(prefixMatch[1]);
    if (code >= 400 && code <= 599) {
      statusCode = code;
      body = (prefixMatch[2] ?? "").trim();
    }
  }

  const obj = parseJsonObjectSafe(body);
  if (obj) {
    const errNode =
      obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)
        ? (obj.error as Record<string, unknown>)
        : null;

    const msgCandidate =
      (typeof errNode?.message === "string" && errNode.message) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.detail === "string" && obj.detail) ||
      (typeof obj.error === "string" && obj.error) ||
      undefined;

    const typeCandidate =
      (typeof errNode?.type === "string" && errNode.type) ||
      (typeof obj.type === "string" && obj.type) ||
      undefined;

    const codeCandidate =
      errNode?.code ?? obj.code ?? errNode?.status ?? obj.status;

    if (typeof codeCandidate === "number" && codeCandidate >= 400 && codeCandidate <= 599) {
      statusCode ??= codeCandidate;
    }

    return {
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(msgCandidate ? { message: msgCandidate.trim() } : {}),
      ...(typeCandidate ? { errorType: typeCandidate.trim() } : {}),
      ...(codeCandidate !== undefined && codeCandidate !== ""
        ? { errorCode: String(codeCandidate).trim() }
        : {}),
    };
  }

  const embeddedStatus = /\b(400|401|402|403|404|413|415|422|429|500|502|503|504)\b/.exec(body);
  if (embeddedStatus) {
    statusCode ??= Number(embeddedStatus[1]);
  }

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(body ? { message: body } : {}),
  };
}

/**
 * Recursively unwrap HTTP status prefixes and nested upstream JSON error payloads
 * into clean diagnostic fields.
 */
export function extractUpstreamErrorInfo(raw: string): {
  statusCode?: number;
  cleanMessage?: string;
  errorType?: string;
  errorCode?: string;
  combinedText: string;
} {
  const fragments: string[] = [raw.trim()];
  let statusCode: number | undefined;
  let errorType: string | undefined;
  let errorCode: string | undefined;
  let cleanMessage: string | undefined;

  let current = raw.trim();
  for (let depth = 0; depth < 3 && current; depth++) {
    const layer = parseSingleErrorLayer(current);
    statusCode ??= layer.statusCode;
    errorType ??= layer.errorType;
    errorCode ??= layer.errorCode;
    if (layer.message) {
      fragments.push(layer.message);
      cleanMessage = layer.message;
      if (layer.message === current) break;
      current = layer.message;
    } else {
      break;
    }
  }

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cleanMessage ? { cleanMessage } : {}),
    ...(errorType ? { errorType } : {}),
    ...(errorCode ? { errorCode } : {}),
    combinedText: fragments.filter(Boolean).join("\n"),
  };
}

function buildRawDetail(input: FriendlyErrorInput): string | undefined {
  const parts: string[] = [];
  const reason = input.reason?.trim();
  const detail = input.detail?.trim();
  const rawMessage = input.rawMessage?.trim();

  if (reason && !(reason === "model_error" && detail)) {
    parts.push(reason);
  }
  if (detail) {
    parts.push(detail);
  }
  if (rawMessage && rawMessage !== detail) {
    parts.push(rawMessage);
  }

  if (parts.length === 0) return undefined;
  const joined = redactSecrets(parts.join(" · "));
  return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined;
}

/**
 * Translate raw Hub / pi-durable / upstream gateway errors into friendly Chinese diagnostics.
 */
export function describeMocoError(input: FriendlyErrorInput): FriendlyErrorDescriptor {
  const reason = input.reason?.trim();
  const detail = input.detail?.trim();
  const rawMessage = input.rawMessage?.trim();
  const modelLabel = input.modelId?.trim();

  if (reason === "aborted" && !detail && !rawMessage) {
    return {
      kind: "user_abort",
      title: "已停止生成",
      hint: "当前回复已手动停止。",
      retryable: true,
      suggestModelSettings: false,
      isUserAbort: true,
    };
  }

  const rawDetail = buildRawDetail(input);
  const sourceText = detail || rawMessage || "";
  const info = extractUpstreamErrorInfo(sourceText);

  if (reason === "turn_limit") {
    return {
      kind: "turn_limit",
      title: "已达到单轮执行步数上限",
      hint: "为避免循环调用，本轮已自动暂停。点击「继续生成」即可接着往下执行。",
      ...(info.statusCode !== undefined ? { statusCode: info.statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: false,
      isUserAbort: false,
    };
  }

  if (
    reason === "interrupted" ||
    reason === "restart_limit" ||
    (reason === "aborted" && Boolean(detail))
  ) {
    return {
      kind: "interrupted",
      title: "回复生成意外中断",
      hint: "运行中断或服务重启导致本轮未完成，点击「重试」即可继续生成。",
      ...(info.statusCode !== undefined ? { statusCode: info.statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: false,
      isUserAbort: false,
    };
  }

  const haystack = [
    reason ?? "",
    info.combinedText,
    info.errorType ?? "",
    info.errorCode ?? "",
  ]
    .join("\n")
    .toLowerCase();

  const statusCode = info.statusCode;

  if (
    haystack.includes("disabled in this account") ||
    haystack.includes("violation of terms of service") ||
    haystack.includes("account has been disabled") ||
    haystack.includes("account is deactivated") ||
    haystack.includes("auth_unavailable") ||
    haystack.includes("no auth available") ||
    haystack.includes("channel_disabled") ||
    haystack.includes("暂无可用通道") ||
    haystack.includes("无可用渠道") ||
    (info.errorType === "upstream_error" && (statusCode === 403 || statusCode === 503))
  ) {
    return {
      kind: "upstream_disabled",
      title: "上游模型通道当前不可用",
      hint: modelLabel
        ? `网关上游为模型「${modelLabel}」分配的账号或渠道已被停用或暂无可用号池（并非图片或附件上传失败）。请前往「模型设置」切换其他可用模型，或检查网关上游渠道。`
        : "当前模型在网关上游的账号或渠道已被停用或暂无可用号池（并非图片或附件上传失败）。请前往「模型设置」切换其他可用模型，或检查网关上游渠道状态。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    statusCode === 401 ||
    haystack.includes("invalid_api_key") ||
    haystack.includes("incorrect api key") ||
    haystack.includes("unauthorized") ||
    haystack.includes("authentication_error") ||
    haystack.includes("api key not valid") ||
    haystack.includes("无效的令牌") ||
    haystack.includes("身份验证失败")
  ) {
    return {
      kind: "auth",
      title: "模型接口鉴权失败",
      hint: "接口密钥（API Key）无效、已过期或未填写。请前往「模型设置」更新密钥后再重试。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    statusCode === 402 ||
    haystack.includes("insufficient_quota") ||
    haystack.includes("quota exceeded") ||
    haystack.includes("credit balance") ||
    haystack.includes("billing_not_active") ||
    haystack.includes("余额不足") ||
    haystack.includes("额度不足") ||
    haystack.includes("欠费")
  ) {
    return {
      kind: "quota",
      title: "模型额度或账户余额不足",
      hint: "当前网关账户或密钥可用额度已耗尽。请充值、更换密钥，或在「模型设置」中切换其他模型。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    reason === "no_model" ||
    statusCode === 404 ||
    haystack.includes("model_not_found") ||
    haystack.includes("model not found") ||
    haystack.includes("unknown model") ||
    haystack.includes("does not exist") ||
    haystack.includes("未找到模型") ||
    haystack.includes("模型不存在")
  ) {
    return {
      kind: "model_not_found",
      title: "未找到当前配置的模型",
      hint: modelLabel
        ? `网关不支持或未开通模型「${modelLabel}」，也可能网关地址填写有误。请在「模型设置」中检测连接并改选可用模型。`
        : "当前网关不支持所选模型名称，或网关地址有误。请在「模型设置」中检测连接并改选可用模型。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    (statusCode === undefined || statusCode === 400 || statusCode === 415 || statusCode === 422) &&
    (haystack.includes("image_url") ||
      haystack.includes("does not support image") ||
      haystack.includes("unsupported image") ||
      haystack.includes("image input") ||
      haystack.includes("vision") ||
      haystack.includes("multimodal") ||
      haystack.includes("不支持图片") ||
      haystack.includes("不支持图像"))
  ) {
    return {
      kind: "multimodal_unsupported",
      title: "当前模型不支持图片理解",
      hint: "所选模型无法处理图片输入。请在「模型设置」中切换支持视觉理解的多模态模型后再重试。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    statusCode === 413 ||
    haystack.includes("context_length_exceeded") ||
    haystack.includes("maximum context length") ||
    haystack.includes("prompt is too long") ||
    haystack.includes("too many tokens") ||
    haystack.includes("上下文过长") ||
    haystack.includes("超出最大长度")
  ) {
    return {
      kind: "context_overflow",
      title: "对话内容超出模型上下文上限",
      hint: "当前话题累计消息或附件体积超出了模型窗口限制。建议新建一个话题继续提问，或切换长上下文模型。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: false,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    statusCode === 403 ||
    haystack.includes("forbidden") ||
    haystack.includes("permission_denied") ||
    haystack.includes("access denied") ||
    haystack.includes("无权访问")
  ) {
    return {
      kind: "forbidden",
      title: "模型服务拒绝了本次请求",
      hint: "网关或上游权限策略拦截了本次请求（例如当前密钥无该模型权限或触发风控）。可尝试在「模型设置」切换模型或检查网关权限。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (
    statusCode === 429 ||
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("too many requests") ||
    haystack.includes("请求过于频繁") ||
    haystack.includes("并发超限")
  ) {
    return {
      kind: "rate_limit",
      title: "模型请求过于频繁",
      hint: "当前模型通道触发了速率或并发限制，稍等片刻后点击「重试」即可恢复。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: false,
      isUserAbort: false,
    };
  }

  if (
    (statusCode !== undefined && statusCode >= 500) ||
    haystack.includes("fetch failed") ||
    haystack.includes("econnrefused") ||
    haystack.includes("enotfound") ||
    haystack.includes("etimedout") ||
    haystack.includes("econnreset") ||
    haystack.includes("socket hang up") ||
    haystack.includes("timed out") ||
    haystack.includes("timeout") ||
    haystack.includes("bad gateway") ||
    haystack.includes("service unavailable") ||
    haystack.includes("gateway timeout")
  ) {
    return {
      kind: "gateway_unavailable",
      title: "模型网关连接异常或响应超时",
      hint: "无法稳定连接到模型网关或上游响应超时。请稍后点击「重试」，若持续出现请前往「模型设置」检查网关地址与网络。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  if (reason === "model_error" || statusCode !== undefined) {
    return {
      kind: "unknown",
      title: "模型服务暂时未能完成回复",
      hint: "调用模型接口时返回异常响应。可点击「重试」再试一次，或展开下方诊断信息排查网关与模型配置。",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(rawDetail ? { rawDetail } : {}),
      retryable: true,
      suggestModelSettings: true,
      isUserAbort: false,
    };
  }

  const clean = info.cleanMessage ? redactSecrets(info.cleanMessage) : "";
  return {
    kind: "unknown",
    title: "操作未能完成",
    hint:
      clean && clean.length <= 180
        ? clean
        : "请求处理过程中遇到异常，请稍后重试。",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(rawDetail && rawDetail !== clean ? { rawDetail } : {}),
    retryable: false,
    suggestModelSettings: false,
    isUserAbort: false,
  };
}
