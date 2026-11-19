import { translate as tr, useI18n } from "../../moco-i18n";
import { useState } from "react";
import { Alert, Button, Chip, Disclosure } from "@heroui/react";
import type { FriendlyErrorDescriptor } from "@moco/protocol";
import { MocoIcon } from "../../moco-icon";

export function MocoTurnErrorCard({
  descriptor,
  modelId,
  retrying,
  onRetry,
  onOpenModelSettings,
  onDismiss,
}: {
  descriptor: FriendlyErrorDescriptor;
  modelId?: string;
  retrying: boolean;
  onRetry: () => void;
  onOpenModelSettings?: () => void;
  onDismiss: () => void;
}) {
  useI18n();
  const [copied, setCopied] = useState(false);

  const copyDetail = () => {
    if (!descriptor.rawDetail) return;
    navigator.clipboard?.writeText(descriptor.rawDetail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <Alert status="danger" className="flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex w-full items-start gap-3">
        <Alert.Indicator className="mt-0.5 shrink-0" />
        <Alert.Content className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Alert.Title className="text-sm font-semibold">{descriptor.title}</Alert.Title>
            {descriptor.statusCode !== undefined && (
              <Chip size="sm" variant="soft" color="danger" className="font-mono">
                HTTP {descriptor.statusCode}
              </Chip>
            )}
            {modelId && (
              <Chip size="sm" variant="soft" className="font-mono">
                {modelId}
              </Chip>
            )}
          </div>

          <Alert.Description>
            {descriptor.hint}
          </Alert.Description>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {descriptor.retryable && (
              <Button
                size="sm"
                variant="secondary"
                isPending={retrying}
                isDisabled={retrying}
                onPress={onRetry}
              >
                <MocoIcon name="refresh" size={16} />
                {retrying
                  ? tr("正在重试…", "Retrying…")
                  : descriptor.kind === "turn_limit"
                    ? tr("继续生成", "Continue generating")
                    : tr("重试", "Retry")}
              </Button>
            )}
            {descriptor.suggestModelSettings && onOpenModelSettings && (
              <Button size="sm" variant="tertiary" onPress={onOpenModelSettings}>
                {tr("前往模型设置", "Open model settings")}</Button>
            )}
            <Button size="sm" variant="ghost" onPress={onDismiss}>
              {tr("关闭", "Close")}</Button>
          </div>

          {descriptor.rawDetail && (
            <Disclosure className="mt-1 w-full">
              <Disclosure.Heading>
                <Disclosure.Trigger className="flex items-center gap-1.5 py-1 text-xs font-medium text-muted hover:text-foreground">
                  <Disclosure.Indicator />
                  {tr("查看原始诊断信息", "View diagnostic details")}</Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <Disclosure.Body className="mt-1 rounded-xl border border-border bg-surface p-2.5">
                  <div className="mb-1.5 flex justify-end">
                    <Button size="sm" variant="ghost" onPress={copyDetail}>
                      <MocoIcon name={copied ? "check" : "copy"} size={14} />
                      {copied ? tr("已复制", "Copied") : tr("复制", "Copy")}
                    </Button>
                  </div>
                  <pre className="scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
                    {descriptor.rawDetail}
                  </pre>
                </Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          )}
        </Alert.Content>

        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={tr("关闭错误提示", "Dismiss error")}
          onPress={onDismiss}
        >
          <MocoIcon name="close" size={16} />
        </Button>
      </div>
    </Alert>
  );
}
