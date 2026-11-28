import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, CheckboxGroup, Chip, Label, Modal, Spinner } from "@heroui/react";
import {
  redactSensitiveText,
  type MigrationImportItemOutcome,
  type MigrationMcpCandidate,
  type MigrationScanResult,
  type MigrationSkillCandidate,
  type MigrationStdioPrefill,
  type MigrationStdioRiskFlag,
  type SkillAudience,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { translate, useI18n } from "../../kulo-i18n";

export function stdioRiskLabel(flag: MigrationStdioRiskFlag): string {
  switch (flag) {
    case "shell_exec":
      return translate("高风险 Shell 执行", "High-risk shell exec");
    case "pipe_download":
      return translate("高风险管道下载执行", "High-risk pipe download");
    case "ephemeral_runner":
      return translate("临时包执行 (npx -y / uvx)", "Ephemeral runner (npx -y / uvx)");
    case "relative_command":
      return translate("相对路径命令", "Relative command path");
    case "inline_secret_stripped":
      return translate("已剥离内联凭据", "Inline secret stripped");
  }
}

export function isHighRiskStdioFlag(flag: MigrationStdioRiskFlag): boolean {
  return flag === "shell_exec" || flag === "pipe_download" || flag === "ephemeral_runner" || flag === "relative_command";
}

function outcomeStatusColor(status: MigrationImportItemOutcome["status"]): "success" | "default" | "danger" {
  return status === "imported" ? "success" : status === "skipped" ? "default" : "danger";
}

function outcomeStatusLabel(status: MigrationImportItemOutcome["status"]): string {
  return status === "imported"
    ? translate("已导入", "Imported")
    : status === "skipped"
      ? translate("已跳过", "Skipped")
      : translate("失败", "Failed");
}

function HttpMcpRow({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: MigrationMcpCandidate;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const selectable = item.importable && !item.alreadyImported;
  return (
    <div className="kulo-settings-list-row items-start justify-between gap-3">
      <Checkbox
        variant="secondary"
        isSelected={checked}
        isDisabled={disabled || !selectable}
        onChange={onToggle}
        aria-label={t(`选择导入 ${item.name}`, `Select ${item.name} for import`)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="kulo-item-title">{item.name}</span>
          <Chip size="sm" variant="soft">{item.sourceLabel}</Chip>
          {item.inferredAuthMode && <Chip size="sm" variant="soft">{item.inferredAuthMode}</Chip>}
          {item.disabledInSource && <Chip size="sm" variant="soft" color="warning">{t("原已禁用", "Disabled in source")}</Chip>}
          {item.alreadyImported && <Chip size="sm" variant="soft" color="success">{t("已导入", "Imported")}</Chip>}
          {item.hadSecretsStripped && <Chip size="sm" variant="soft">{t("凭据已剥离", "Secrets stripped")}</Chip>}
        </div>
        <div className="kulo-item-description">
          {item.hostSummary ? `${item.hostSummary} · ` : ""}
          {item.sourcePath}
        </div>
        {item.pendingItems.length > 0 && (
          <div className="space-y-0.5 text-xs text-muted">
            {item.pendingItems.map((pending, idx) => (
              <div key={`${item.candidateId}:p:${idx}`}>
                {pending.message}
                {pending.detail ? `（${pending.detail}）` : ""}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillCandidateRow({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: MigrationSkillCandidate;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const selectable = item.importable && !item.conflictWithManaged;
  return (
    <div className="kulo-settings-list-row items-start justify-between gap-3">
      <Checkbox
        variant="secondary"
        isSelected={checked}
        isDisabled={disabled || !selectable}
        onChange={onToggle}
        aria-label={t(`选择导入技能 ${item.normalizedName}`, `Select skill ${item.normalizedName}`)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="kulo-item-title">{item.normalizedName}</span>
          <Chip size="sm" variant="soft">{item.sourceLabel}</Chip>
          <Chip size="sm" variant="soft">{t("默认停用", "Disabled by default")}</Chip>
          {item.nameNormalized && (
            <Chip size="sm" variant="soft">{`${item.originalName} → ${item.normalizedName}`}</Chip>
          )}
          {item.conflictWithManaged && (
            <Chip size="sm" variant="soft" color="warning">{t("保留 Kulo 托管版", "Kulo managed kept")}</Chip>
          )}
          {!item.importable && !item.conflictWithManaged && (
            <Chip size="sm" variant="soft" color="danger">{t("已拦截", "Blocked")}</Chip>
          )}
        </div>
        {item.descriptionSummary && <div className="kulo-item-description">{item.descriptionSummary}</div>}
        <div className="text-xs text-muted">
          {item.sourcePath}
          {item.sha256 ? ` · sha256:${item.sha256.slice(0, 12)}` : ""}
        </div>
        {item.blockedReason && <div className="text-xs text-danger">{item.blockedReason}</div>}
      </div>
    </div>
  );
}

function StdioChecklistRow({
  item,
  busy,
  canPrefill,
  onPrefill,
}: {
  item: MigrationMcpCandidate;
  busy: boolean;
  canPrefill: boolean;
  onPrefill: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="kulo-settings-list-row items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="kulo-item-title">{item.name}</span>
          <Chip size="sm" variant="soft">{item.sourceLabel}</Chip>
          <Chip size="sm" variant="soft">{t("只读清单", "Read-only")}</Chip>
          {item.riskFlags.map((flag) => (
            <Chip
              key={flag}
              size="sm"
              variant="soft"
              color={isHighRiskStdioFlag(flag) ? "danger" : "warning"}
            >
              {stdioRiskLabel(flag)}
            </Chip>
          ))}
        </div>
        <div className="kulo-item-description">
          {item.commandSummary ? `${item.commandSummary} · ` : ""}
          {item.sourcePath}
        </div>
        {item.requiredEnvKeys && item.requiredEnvKeys.length > 0 && (
          <div className="text-xs text-muted">
            {t("需手动补填环境变量：", "Env vars to fill manually: ")}
            {item.requiredEnvKeys.join(", ")}
          </div>
        )}
      </div>
      {canPrefill && (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          aria-label={t(`预填 ${item.name} 手动表单`, `Prefill manual form for ${item.name}`)}
          onPress={onPrefill}
        >
          {t("预填表单", "Prefill form")}
        </Button>
      )}
    </div>
  );
}

export function MigrationImportBody({
  localHost,
  error,
  scanning,
  outcomes,
  scan,
  initialSection = "mcp",
  busy,
  selectedMcp,
  selectedSkills,
  skillAudiences,
  canPrefill,
  onToggleMcp,
  onToggleSkill,
  onChangeSkillAudiences,
  onPrefillStdio,
}: {
  localHost: boolean;
  error: string | null;
  scanning: boolean;
  outcomes: MigrationImportItemOutcome[] | null;
  scan: MigrationScanResult | null;
  initialSection?: "mcp" | "skills";
  busy: boolean;
  selectedMcp: ReadonlySet<string>;
  selectedSkills: ReadonlySet<string>;
  skillAudiences: SkillAudience[];
  canPrefill: boolean;
  onToggleMcp: (id: string, checked: boolean) => void;
  onToggleSkill: (id: string, checked: boolean) => void;
  onChangeSkillAudiences: (next: SkillAudience[]) => void;
  onPrefillStdio: (candidateId: string) => void;
}) {
  const { t } = useI18n();
  const hasAnyCandidate = Boolean(
    scan &&
      (scan.httpMcpCandidates.length > 0 ||
        scan.skillCandidates.length > 0 ||
        scan.stdioMcpCandidates.length > 0 ||
        scan.manualNotices.length > 0),
  );
  const sectionsOrder: Array<"mcp" | "skills"> = initialSection === "skills" ? ["skills", "mcp"] : ["mcp", "skills"];

  return (
    <>
      {!localHost && (
        <Alert status="warning" role="alert">
          <Alert.Content>
            <Alert.Description>
              {t("仅限 Hub 本机控制台扫描与导入。", "Local console access on the Hub host is required.")}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {error && (
        <Alert status="danger" role="alert">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {scanning && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner size="sm" />
          {t("正在本机扫描配置文件与技能快照…", "Scanning local configs and skills…")}
        </div>
      )}

      {outcomes && outcomes.length > 0 && (
        <div className="kulo-list-surface scrollbar max-h-40 overflow-y-auto" role="status" aria-label={t("导入结果", "Import results")}>
          {outcomes.map((item) => (
            <div key={`${item.kind}:${item.candidateId}`} className="kulo-settings-list-row justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="kulo-item-title">{item.name}</span>
                <div className="kulo-item-description">{item.message}</div>
              </div>
              <Chip size="sm" variant="soft" color={outcomeStatusColor(item.status)}>
                {outcomeStatusLabel(item.status)}
              </Chip>
            </div>
          ))}
        </div>
      )}

      {!scanning && scan && !hasAnyCandidate && (
        <div className="kulo-table-empty-state">
          {t("未在本机发现可导入的 Claude Code、Cursor、Antigravity、Codex 或 ~/.agents/skills 配置。", "No local Claude Code, Cursor, Antigravity, Codex, or ~/.agents/skills configs found.")}
        </div>
      )}

      {!scanning && scan && hasAnyCandidate && (
        <div className="scrollbar max-h-96 space-y-5 overflow-y-auto pr-1">
          {sectionsOrder.map((sectionKey) => {
            if (sectionKey === "mcp") {
              return (
                <section key="http-mcp" className="space-y-2" aria-label={t("HTTP MCP", "HTTP MCP")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{t("HTTP MCP（无凭据导入）", "HTTP MCP (credential-free)")}</span>
                    <Chip size="sm" variant="soft">
                      {`${scan.currentConnectionCount}/${scan.maxConnections}`}
                    </Chip>
                  </div>
                  {scan.httpMcpCandidates.length === 0 ? (
                    <div className="text-xs text-muted">{t("未发现 HTTP MCP", "No HTTP MCP servers found")}</div>
                  ) : (
                    <div className="kulo-list-surface">
                      {scan.httpMcpCandidates.map((item) => (
                        <HttpMcpRow
                          key={item.candidateId}
                          item={item}
                          checked={selectedMcp.has(item.candidateId)}
                          disabled={busy}
                          onToggle={(next) => onToggleMcp(item.candidateId, next)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            }
            return (
              <section key="skills" className="space-y-2" aria-label={t("Skills 快照", "Skills snapshots")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{t("Skills 快照（默认停用）", "Skills snapshots (disabled by default)")}</span>
                  <Chip size="sm" variant="soft">{scan.skillCandidates.length}</Chip>
                </div>
                {scan.skillCandidates.length === 0 ? (
                  <div className="text-xs text-muted">{t("未发现本地技能目录", "No local skills found")}</div>
                ) : (
                  <>
                    <CheckboxGroup
                      className="kulo-form-field"
                      value={skillAudiences}
                      onChange={(vals) => {
                        const next = (vals as SkillAudience[]).filter((v) => v === "worker" || v === "chat");
                        onChangeSkillAudiences(next.length ? next : ["worker"]);
                      }}
                      isDisabled={busy}
                    >
                      <Label>{t("导入技能默认受众", "Default audiences for imported skills")}</Label>
                      <div className="flex flex-wrap gap-4">
                        <Checkbox value="worker" variant="secondary">
                          <Checkbox.Content>
                            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            {t("后台任务（默认）", "Background tasks (default)")}
                          </Checkbox.Content>
                        </Checkbox>
                        <Checkbox value="chat" variant="secondary">
                          <Checkbox.Content>
                            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            {t("主聊天（需手动勾选）", "Main chat (opt-in)")}
                          </Checkbox.Content>
                        </Checkbox>
                      </div>
                    </CheckboxGroup>
                    <div className="kulo-list-surface">
                      {scan.skillCandidates.map((item) => (
                        <SkillCandidateRow
                          key={item.candidateId}
                          item={item}
                          checked={selectedSkills.has(item.candidateId)}
                          disabled={busy}
                          onToggle={(next) => onToggleSkill(item.candidateId, next)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>
            );
          })}

          {scan.stdioMcpCandidates.length > 0 && (
            <section className="space-y-2" aria-label={t("本地命令 stdio", "Local stdio commands")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">
                  {t("本地命令 stdio（只读清单 · 不自动执行）", "Local stdio commands (read-only · never auto-run)")}
                </span>
                <Chip size="sm" variant="soft" color="warning">{scan.stdioMcpCandidates.length}</Chip>
              </div>
              <div className="kulo-list-surface">
                {scan.stdioMcpCandidates.map((item) => (
                  <StdioChecklistRow
                    key={item.candidateId}
                    item={item}
                    busy={busy}
                    canPrefill={canPrefill}
                    onPrefill={() => onPrefillStdio(item.candidateId)}
                  />
                ))}
              </div>
            </section>
          )}

          {scan.manualNotices.length > 0 && (
            <section className="space-y-2" aria-label={t("手工核对提示", "Manual notices")}>
              <span className="text-sm font-semibold">{t("需手工核对项", "Manual checklist")}</span>
              {scan.manualNotices.map((notice, idx) => (
                <Alert key={`${notice.sourcePath}:${idx}`} status="warning">
                  <Alert.Content>
                    <Alert.Title>{`${notice.sourceLabel} · ${notice.sourcePath}`}</Alert.Title>
                    <Alert.Description>{notice.message}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}

export function MigrationImportModal({
  open,
  connected,
  localHost,
  initialSection = "mcp",
  initialScan = null,
  onImported,
  onPrefillStdio,
  onClose,
}: {
  open: boolean;
  connected: boolean;
  localHost: boolean;
  initialSection?: "mcp" | "skills";
  initialScan?: MigrationScanResult | null;
  onImported?: () => void;
  onPrefillStdio?: (prefill: MigrationStdioPrefill) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [scan, setScan] = useState<MigrationScanResult | null>(initialScan);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [prefillingId, setPrefillingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMcp, setSelectedMcp] = useState<Set<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [skillAudiences, setSkillAudiences] = useState<SkillAudience[]>(["worker"]);
  const [outcomes, setOutcomes] = useState<MigrationImportItemOutcome[] | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const runScan = useCallback(async () => {
    if (!connected || !localHost) return;
    setScanning(true);
    setError(null);
    setOutcomes(null);
    setSelectedMcp(new Set());
    setSelectedSkills(new Set());
    setSkillAudiences(["worker"]);
    try {
      const next = await kuloRest.scanLocalMigration();
      if (mounted.current) setScan(next);
    } catch (cause) {
      if (mounted.current) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("扫描本机配置失败。", "Failed to scan local configs.")));
      }
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [connected, localHost, t]);

  useEffect(() => {
    if (!open) return;
    if (initialScan) {
      setScan(initialScan);
      setError(null);
      setOutcomes(null);
      setSelectedMcp(new Set());
      setSelectedSkills(new Set());
      setSkillAudiences(["worker"]);
      return;
    }
    void runScan();
  }, [open, initialScan, runScan]);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, checked: boolean) => {
    setter((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleImport = async () => {
    if (!scan || importing || scanning || !connected || !localHost) return;
    if (selectedMcp.size === 0 && selectedSkills.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await kuloRest.importLocalMigration({
        scanId: scan.scanId,
        commandId: globalThis.crypto?.randomUUID?.() ?? `mig-${Date.now()}`,
        mcpCandidateIds: [...selectedMcp],
        skillCandidateIds: [...selectedSkills],
        skillAudiences: skillAudiences.length > 0 ? skillAudiences : ["worker"],
      });
      if (!mounted.current) return;
      setOutcomes(res.results);
      if (res.summary.imported > 0) {
        onImported?.();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("导入失败，请重试。", "Import failed. Please retry.")));
      }
    } finally {
      if (mounted.current) setImporting(false);
    }
  };

  const handlePrefillStdio = async (candidateId: string) => {
    if (!scan || !onPrefillStdio || importing || scanning || prefillingId) return;
    setPrefillingId(candidateId);
    setError(null);
    try {
      const res = await kuloRest.importLocalMigration({
        scanId: scan.scanId,
        stdioPrefillCandidateId: candidateId,
      });
      if (!mounted.current) return;
      if (res.stdioPrefill) {
        onClose();
        onPrefillStdio(res.stdioPrefill);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(redactSensitiveText(cause instanceof Error ? cause.message : t("生成手动预填失败。", "Failed to prepare manual prefill.")));
      }
    } finally {
      if (mounted.current) setPrefillingId(null);
    }
  };

  const busy = scanning || importing || prefillingId !== null;
  const totalSelected = selectedMcp.size + selectedSkills.size;

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Backdrop
        isOpen={open}
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
        onOpenChange={(next) => {
          if (!next && !busy) onClose();
        }}
      >
        <Modal.Container placement="center" size="lg" scroll="inside">
          <Modal.Dialog aria-label={t("从本机工具发现与导入", "Discover & import local configs")} className="w-full max-w-[640px] rounded-3xl">
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">
                {t("本机配置发现与安全导入", "Local config discovery & safe import")}
              </Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭", "Close")} className="static" isDisabled={busy} onPress={onClose} />
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              <MigrationImportBody
                localHost={localHost}
                error={error}
                scanning={scanning}
                outcomes={outcomes}
                scan={scan}
                initialSection={initialSection}
                busy={busy}
                selectedMcp={selectedMcp}
                selectedSkills={selectedSkills}
                skillAudiences={skillAudiences}
                canPrefill={Boolean(onPrefillStdio)}
                onToggleMcp={(id, checked) => toggleSet(setSelectedMcp, id, checked)}
                onToggleSkill={(id, checked) => toggleSet(setSelectedSkills, id, checked)}
                onChangeSkillAudiences={setSkillAudiences}
                onPrefillStdio={(candidateId) => void handlePrefillStdio(candidateId)}
              />
            </Modal.Body>

            <Modal.Footer className="flex flex-row items-center justify-between gap-2">
              <Button size="sm" variant="ghost" isDisabled={busy || !connected || !localHost} onPress={() => void runScan()}>
                {t("重新扫描", "Rescan")}
              </Button>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="tertiary" isDisabled={busy} onPress={onClose}>
                  {t("关闭", "Close")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={importing}
                  isDisabled={busy || !connected || !localHost || totalSelected === 0}
                  onPress={() => void handleImport()}
                >
                  {t(`导入所选 (${totalSelected})`, `Import selected (${totalSelected})`)}
                </Button>
              </div>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
