import type {
  OverflowReportAsset,
  WorkerExecutionPhase,
  WorkerInspectResult,
  WorkerReportRecord,
} from "@moco/protocol";
import type { MocoUploadStore } from "./uploads.js";

export const REPORT_DELIVERABLE_OVERFLOW_CHARS = 8_000;
export const REPORT_DELIVERABLE_PREVIEW_CHARS = 2_000;
export const REPORT_SUMMARY_MAX_CHARS = 4_000;
export const REPORT_QUESTION_MAX_CHARS = 2_000;
export const CARD_DELIVERABLE_MAX_CHARS = 2_000;
export const SUBAGENT_INLINE_MAX_CHARS = 8_000;
export const INSPECT_RESULT_MAX_UTF8_BYTES = 8_192;

const TRUNCATION_SUFFIX = " ...[truncated]";
const MARKDOWN_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  return `${value.slice(0, keep)}${TRUNCATION_SUFFIX}`;
}

export function extractMarkdownSourceLinks(text: string): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ title: string; url: string }> = [];
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    links.push({ title, url });
    if (links.length >= 25) break;
  }
  return links;
}

export function clampReportBounds(report: WorkerReportRecord): WorkerReportRecord {
  return {
    ...report,
    summary: clampText(report.summary, REPORT_SUMMARY_MAX_CHARS),
    ...(report.question !== undefined
      ? { question: clampText(report.question, REPORT_QUESTION_MAX_CHARS) }
      : {}),
  };
}

export function spillOversizedReport(options: {
  uploads?: MocoUploadStore;
  ticketId: string;
  runEpoch: number;
  version: number | string;
  ownerConversationId: number;
  originConversationId?: number;
  report: WorkerReportRecord;
}): WorkerReportRecord {
  const bounded = clampReportBounds(options.report);
  const fullDeliverable = bounded.deliverable;
  if (!fullDeliverable || fullDeliverable.length <= REPORT_DELIVERABLE_OVERFLOW_CHARS) {
    return bounded;
  }

  const allLinks = extractMarkdownSourceLinks(fullDeliverable);
  let previewHead = fullDeliverable.slice(0, REPORT_DELIVERABLE_PREVIEW_CHARS);
  const lastNewline = previewHead.lastIndexOf("\n");
  if (lastNewline > REPORT_DELIVERABLE_PREVIEW_CHARS - 200) {
    previewHead = previewHead.slice(0, lastNewline);
  }
  const missingLinks = allLinks.filter((link) => !previewHead.includes(link.url));
  const preservedSourcesBlock = missingLinks.length
    ? `\n\nPreserved Sources:\n${missingLinks.slice(0, 15).map((link) => `- [${link.title}](${link.url})`).join("\n")}`
    : "";

  if (!options.uploads) {
    return {
      ...bounded,
      deliverable: `${previewHead}\n\n[Deliverable truncated to ${previewHead.length} of ${fullDeliverable.length} chars]${preservedSourcesBlock}`,
    };
  }

  const ownerId = `agent:${options.ownerConversationId}`;
  const safeTicketId = options.ticketId.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeVersion = String(options.version).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const idempotencyKey = `spillover:${options.ticketId}:${options.runEpoch}:${options.version}`;
  const saved = options.uploads.saveUpload({
    name: `overflow-report-${safeTicketId}-e${options.runEpoch}-v${safeVersion}.md`,
    mimeType: "text/markdown",
    bytes: Buffer.from(fullDeliverable, "utf8"),
    ownerId,
    idempotencyKey,
    internalOnly: true,
  });
  options.uploads.bindAttachments([saved], `ticket:${options.ticketId}`, ownerId);
  options.uploads.bindAttachments([saved], `conversation:${options.ownerConversationId}`, ownerId);
  if (options.originConversationId !== undefined) {
    options.uploads.bindAttachments([saved], `conversation:${options.originConversationId}`, ownerId);
  }

  const overflowAsset: OverflowReportAsset = {
    id: saved.id,
    name: saved.name,
    size: saved.size,
    totalChars: fullDeliverable.length,
  };

  return {
    ...bounded,
    deliverable:
      `${previewHead}\n\n[Deliverable truncated to ${previewHead.length} of ${fullDeliverable.length} chars; full text stored in internal overflowAsset "${saved.id}" (${saved.name}). Inspect via moco_inspect_asset(asset_id="${saved.id}", offset=..., limit=...).]${preservedSourcesBlock}`,
    overflowAsset,
  };
}

export function clampTicketCardReport(report: WorkerReportRecord | undefined): WorkerReportRecord | undefined {
  if (!report) return undefined;
  const bounded = clampReportBounds(report);
  return {
    ...bounded,
    ...(bounded.deliverable && bounded.deliverable.length > CARD_DELIVERABLE_MAX_CHARS
      ? { deliverable: clampText(bounded.deliverable, CARD_DELIVERABLE_MAX_CHARS) }
      : {}),
  };
}

export function inferBuiltInWorkerPhaseAndFiles(options: {
  activeTools: ReadonlyArray<{ name: string; status: string; outputTail?: string }>;
  recentEntries: ReadonlyArray<{ kind: string; summary: string }>;
  streamingPreview?: string;
  workspaceDir?: string;
}): { phase: WorkerExecutionPhase; touchedFiles?: string[] } {
  const { activeTools, recentEntries, streamingPreview, workspaceDir } = options;
  let phase: WorkerExecutionPhase = "starting";

  const isEditTool = (name: string, text = "") =>
    /\b(write|edit|patch|apply_patch|multi_replace|create_file|write_file|delete_file)\b/i.test(name) ||
    /\b(write_file|edit_file|apply_patch|sed\s+-i)\b/i.test(text);
  const isVerifyText = (text: string) =>
    /\b(test|vitest|jest|pytest|lint|eslint|build|typecheck|tsc|cargo\s+test|go\s+test|pnpm\s+(?:test|build|typecheck|lint))\b/i.test(text);

  if (activeTools.length > 0) {
    if (activeTools.some((t) => isEditTool(t.name, t.outputTail))) {
      phase = "editing";
    } else if (activeTools.some((t) => isVerifyText(`${t.name} ${t.outputTail ?? ""}`))) {
      phase = "verifying";
    } else {
      phase = "investigating";
    }
  } else if (streamingPreview) {
    phase = "responding";
  } else if (recentEntries.length > 0) {
    const latest = recentEntries[recentEntries.length - 1]!;
    if (latest.kind === "assistant") {
      phase = "responding";
    } else if (latest.kind === "tool_call" || latest.kind === "tool_result") {
      if (isVerifyText(latest.summary)) phase = "verifying";
      else if (isEditTool("", latest.summary)) phase = "editing";
      else phase = "investigating";
    } else {
      phase = "investigating";
    }
  }

  const touched = new Set<string>();
  const normalizedWorkspace = workspaceDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  const scanText = (text: string) => {
    const matches = text.matchAll(/(?:^|[\s"'`(])((?:\/[^\s"'`),;:]+)|(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12}))/g);
    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw || raw.includes("://") || raw.startsWith("//")) continue;
      let candidate = raw.replace(/[.,;:]+$/, "");
      if (normalizedWorkspace && candidate.startsWith(`${normalizedWorkspace}/`)) {
        candidate = candidate.slice(normalizedWorkspace.length + 1);
      } else if (candidate.startsWith("/")) {
        continue;
      }
      if (!candidate || candidate.length > 240 || candidate.startsWith("..") || candidate.startsWith(".git/")) continue;
      if (!touched.has(candidate)) {
        if (touched.size >= 25) return;
        touched.add(candidate);
      }
    }
  };
  for (const entry of recentEntries) {
    if (entry.kind === "tool_call" || entry.kind === "tool_result") {
      scanText(entry.summary);
    }
  }
  for (const tool of activeTools) {
    if (tool.outputTail) scanText(tool.outputTail);
  }

  return {
    phase,
    ...(touched.size > 0 ? { touchedFiles: [...touched] } : {}),
  };
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clipStr(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return maxChars <= 3 ? value.slice(0, maxChars) : `${value.slice(0, maxChars - 3)}...`;
}

export function boundInspectResult(
  result: WorkerInspectResult,
  maxUtf8Bytes = INSPECT_RESULT_MAX_UTF8_BYTES,
): WorkerInspectResult {
  if (utf8JsonBytes(result) <= maxUtf8Bytes) {
    return result;
  }

  const out: WorkerInspectResult = JSON.parse(JSON.stringify(result)) as WorkerInspectResult;
  out.truncated = true;
  const fits = () => utf8JsonBytes(out) <= maxUtf8Bytes;

  // Step 1: trim verbose deliverable / preview / active tool output tails
  if (out.latestReport?.deliverable) {
    out.latestReport.deliverable = clipStr(out.latestReport.deliverable, 400);
    if (fits()) return out;
  }
  if (out.thinkingPreview) {
    out.thinkingPreview = clipStr(out.thinkingPreview, 160);
    if (fits()) return out;
  }
  if (out.streamingPreview) {
    out.streamingPreview = clipStr(out.streamingPreview, 400);
    if (fits()) return out;
  }
  for (const tool of out.activeTools) {
    if (tool.outputTail) tool.outputTail = clipStr(tool.outputTail, 120);
  }
  if (fits()) return out;

  // Step 2: clamp recentEntries summaries then drop oldest entries
  for (const entry of out.recentEntries) {
    entry.summary = clipStr(entry.summary, 240);
  }
  if (fits()) return out;

  while (out.recentEntries.length > 0 && !fits()) {
    out.recentEntries.shift();
  }
  if (fits()) return out;

  // Step 3: drop previews, tool output tails, and report deliverable
  delete out.thinkingPreview;
  delete out.streamingPreview;
  for (const tool of out.activeTools) {
    delete tool.outputTail;
  }
  if (out.latestReport?.deliverable) {
    delete out.latestReport.deliverable;
  }
  if (fits()) return out;

  // Step 4: compact report summary/question, touchedFiles, runFailure, permissions
  if (out.latestReport) {
    out.latestReport.summary = clipStr(out.latestReport.summary, 400);
    if (out.latestReport.question) {
      out.latestReport.question = clipStr(out.latestReport.question, 300);
    }
    if (out.latestReport.attachments && out.latestReport.attachments.length > 4) {
      out.latestReport.attachments = out.latestReport.attachments.slice(0, 4);
    }
  }
  if (out.touchedFiles && out.touchedFiles.length > 10) {
    out.touchedFiles = out.touchedFiles.slice(-10);
  }
  if (out.runFailure?.detail) {
    out.runFailure.detail = clipStr(out.runFailure.detail, 400);
  }
  if (out.external?.permissions) {
    for (const perm of out.external.permissions) {
      perm.title = clipStr(perm.title, 200);
      perm.choices = perm.choices.slice(0, 6).map((c) => ({ id: c.id, label: clipStr(c.label, 80) }));
    }
  }
  if (fits()) return out;

  // Step 5: final deterministic safety trim for extreme edge cases
  if (out.activeTools.length > 5) out.activeTools = out.activeTools.slice(0, 5);
  for (const tool of out.activeTools) {
    tool.name = clipStr(tool.name, 80);
  }
  if (out.touchedFiles) out.touchedFiles = out.touchedFiles.slice(-5).map((p) => clipStr(p, 80));
  if (out.latestReport) {
    out.latestReport.summary = clipStr(out.latestReport.summary, 180);
    delete out.latestReport.attachments;
    if (out.latestReport.question) out.latestReport.question = clipStr(out.latestReport.question, 160);
  }
  if (out.runFailure?.detail) {
    out.runFailure.detail = clipStr(out.runFailure.detail, 180);
  }
  if (out.external?.permissions && out.external.permissions.length > 3) {
    out.external.permissions = out.external.permissions.slice(0, 3);
  }
  return out;
}
