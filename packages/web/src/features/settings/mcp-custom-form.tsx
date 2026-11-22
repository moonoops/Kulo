import { useState } from "react";
import {
  Alert,
  Button,
  Disclosure,
  Input,
  Label,
  Link,
  ListBox,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import type { McpAuthMode, McpPresetDefinition } from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import {
  clearConnectionDraftSecrets,
  mcpAuthModeLabel,
  type ConnectionDraft,
} from "./connection-setup-inputs";
import { parseMcpPaste, type ParsedMcpServer } from "./mcp-paste-parser";

function applyParsedServer(
  server: ParsedMcpServer,
  current: ConnectionDraft,
): ConnectionDraft {
  if (server.mcpTransport === "http") {
    return {
      ...clearConnectionDraftSecrets(current),
      kind: "mcp",
      category: "app",
      mcpPresetId: undefined,
      mcpTransport: "http",
      name: server.name,
      url: server.url ?? "",
      mcpAuthMode: server.mcpAuthMode ?? "oauth",
      headerName: server.headerName ?? "X-API-Key",
      apiKey: server.apiKey ?? "",
      credentialFields: [],
      mcpCommand: "",
      mcpArgsText: "",
      mcpCwd: "",
    };
  }
  const envDrafts = (server.envFields ?? []).map((field, index) => ({
    key: `env_${index}_${field.key}`,
    label: field.key,
    value: field.value,
  }));
  return {
    ...clearConnectionDraftSecrets(current),
    kind: "mcp",
    category: "app",
    mcpPresetId: undefined,
    mcpTransport: "stdio",
    name: server.name,
    url: "",
    mcpCommand: server.mcpCommand ?? "",
    mcpArgsText: (server.mcpArgs ?? []).join("\n"),
    mcpCwd: server.mcpCwd ?? "",
    credentialFields: envDrafts,
  };
}

export function McpCustomForm({
  mode,
  selectedPreset,
  draft,
  authModes,
  busy,
  localHost,
  onChange,
  onUpdateDraft,
  onClearError,
  onSubmit,
}: {
  mode: "preset" | "custom";
  selectedPreset: McpPresetDefinition | null;
  draft: ConnectionDraft;
  authModes: readonly McpAuthMode[];
  busy: boolean;
  localHost: boolean;
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
  onUpdateDraft: (updater: (current: ConnectionDraft) => ConnectionDraft) => void;
  onClearError: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteWarnings, setPasteWarnings] = useState<string[]>([]);
  const [parsedChoices, setParsedChoices] = useState<ParsedMcpServer[]>([]);
  const [selectedChoice, setSelectedChoice] = useState<string>("0");

  const addEnvField = () => {
    const key = `env_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
    onUpdateDraft((current) =>
      current.credentialFields.length >= 32
        ? current
        : { ...current, credentialFields: [...current.credentialFields, { key, label: "", value: "" }] },
    );
  };

  const updateEnvField = (key: string, patch: { label?: string; value?: string }) => {
    onUpdateDraft((current) => ({
      ...current,
      credentialFields: current.credentialFields.map((field) => (field.key === key ? { ...field, ...patch } : field)),
    }));
    onClearError();
  };

  const removeEnvField = (key: string) => {
    onUpdateDraft((current) => ({
      ...current,
      credentialFields: current.credentialFields.filter((field) => field.key !== key),
    }));
  };

  const handleParsePaste = () => {
    setPasteError(null);
    setPasteWarnings([]);
    setParsedChoices([]);
    onClearError();
    const res = parseMcpPaste(pasteText, { localHost });
    if (!res.ok) {
      setPasteError(res.error);
      return;
    }
    const first = res.servers[0]!;
    onUpdateDraft((current) => applyParsedServer(first, current));
    setPasteWarnings(first.warnings);
    setPasteText("");
    if (res.servers.length > 1) {
      setParsedChoices(res.servers);
      setSelectedChoice("0");
    }
  };

  const handleSelectParsedChoice = (indexKey: string) => {
    const idx = Number(indexKey);
    const chosen = parsedChoices[idx];
    if (!chosen) return;
    setSelectedChoice(indexKey);
    onUpdateDraft((current) => applyParsedServer(chosen, current));
    setPasteWarnings(chosen.warnings);
    onClearError();
  };

  return (
    <form
      id="kulo-add-mcp-form"
      autoComplete="off"
      className="kulo-form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {mode === "preset" && selectedPreset?.hostedAggregator && (
        <Alert status="default">
          <Alert.Content>
            <Alert.Description>
              {t("此连接由第三方云端托管应用授权与工具执行。", "App authorizations and tool execution are hosted by this third-party service.")}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {mode === "preset" && selectedPreset?.helpUrl && (
        <Link className="self-start text-xs" href={selectedPreset.helpUrl} target="_blank" rel="noopener noreferrer">
          {t("官方指南", "Official guide")}
          <Link.Icon />
        </Link>
      )}

      {mode === "custom" && (
        <div className="kulo-form-stack">
          <div className="kulo-field-action-row">
            <TextField
              className="kulo-form-field min-w-0 flex-1"
              variant="secondary"
              value={pasteText}
              onChange={(value) => {
                setPasteText(value);
                setPasteError(null);
              }}
              isDisabled={busy}
              fullWidth
            >
              <Label>{t("快速粘贴导入", "Paste config")}</Label>
              <TextArea
                rows={2}
                className="scrollbar font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://... / claude mcp add ... / npx ... / mcpServers JSON"
              />
            </TextField>
            <Button
              size="sm"
              variant="secondary"
              className="kulo-field-action-button"
              isDisabled={busy || !pasteText.trim()}
              onPress={handleParsePaste}
            >
              {t("解析", "Parse")}
            </Button>
          </div>

          {pasteError && (
            <Alert status="danger" role="alert">
              <Alert.Content>
                <Alert.Description>{pasteError}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {parsedChoices.length > 1 && (
            <Select
              className="kulo-form-field"
              variant="secondary"
              value={selectedChoice}
              isDisabled={busy}
              onChange={(value) => {
                if (typeof value === "string") handleSelectParsedChoice(value);
              }}
              fullWidth
            >
              <Label>{t("选择要导入的服务", "Select server to import")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {parsedChoices.map((item, idx) => (
                    <ListBox.Item key={String(idx)} id={String(idx)} textValue={item.name}>
                      {item.name}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          )}

          {pasteWarnings.length > 0 && (
            <Alert status="warning">
              <Alert.Content>
                <Alert.Description>{pasteWarnings.join(" ")}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          <Select
            className="kulo-form-field"
            variant="secondary"
            value={draft.mcpTransport}
            isDisabled={busy}
            onChange={(value) => {
              if (value === "http" || value === "stdio") {
                onUpdateDraft((current) => clearConnectionDraftSecrets({
                  ...current,
                  mcpTransport: value,
                  credentialFields: value === "stdio" ? current.credentialFields : [],
                }));
                onClearError();
              }
            }}
            fullWidth
          >
            <Label>{t("接入方式", "Transport")}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="http" textValue={t("远程服务 (HTTP)", "Remote server (HTTP)")}>
                  {t("远程服务 (HTTP)", "Remote server (HTTP)")}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {localHost && (
                  <ListBox.Item id="stdio" textValue={t("本机命令 (Stdio)", "Local command (Stdio)")}>
                    {t("本机命令 (Stdio)", "Local command (Stdio)")}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                )}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      )}

      <TextField
        className="kulo-form-field"
        variant="secondary"
        value={draft.name}
        onChange={(value) => onChange("name", value)}
        isRequired
        isDisabled={busy}
        fullWidth
      >
        <Label>{t("连接名称", "Connection name")}</Label>
        <Input autoFocus={mode === "preset"} maxLength={120} autoComplete="off" />
      </TextField>

      {draft.mcpTransport === "http" ? (
        <>
          <TextField
            className="kulo-form-field"
            variant="secondary"
            value={draft.url}
            onChange={(value) => onChange("url", value)}
            isRequired
            isDisabled={busy}
            isReadOnly={mode === "preset" && Boolean(selectedPreset)}
            fullWidth
          >
            <Label>{t("服务地址", "Server URL")}</Label>
            <Input type="url" autoComplete="off" spellCheck={false} placeholder="https://mcp.example.com/mcp" />
          </TextField>

          {authModes.length > 1 && (
            <Select
              className="kulo-form-field"
              variant="secondary"
              value={draft.mcpAuthMode}
              isDisabled={busy}
              onChange={(value) => {
                if (value === "oauth" || value === "bearer" || value === "header" || value === "none") {
                  onUpdateDraft((current) => clearConnectionDraftSecrets({ ...current, mcpAuthMode: value }));
                  onClearError();
                }
              }}
              fullWidth
            >
              <Label>{t("认证方式", "Authentication")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {authModes.map((item) => (
                    <ListBox.Item key={item} id={item} textValue={mcpAuthModeLabel(item)}>
                      {mcpAuthModeLabel(item)}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          )}

          {draft.mcpAuthMode === "header" && (
            <TextField
              className="kulo-form-field"
              variant="secondary"
              value={draft.headerName}
              onChange={(value) => onChange("headerName", value)}
              isDisabled={busy}
              fullWidth
            >
              <Label>{t("请求头名称", "Header name")}</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
          )}

          {(draft.mcpAuthMode === "bearer" || draft.mcpAuthMode === "header") && (
            <TextField
              className="kulo-form-field"
              variant="secondary"
              type="password"
              value={draft.apiKey}
              onChange={(value) => onChange("apiKey", value)}
              isDisabled={busy}
              fullWidth
            >
              <Label>Token</Label>
              <Input autoComplete="new-password" spellCheck={false} placeholder={t("粘贴 Token", "Paste token")} />
            </TextField>
          )}

          {draft.mcpAuthMode === "oauth" && (
            mode === "preset" && selectedPreset?.requiresClientId ? (
              <>
                <TextField
                  className="kulo-form-field"
                  variant="secondary"
                  value={draft.mcpOAuthClientId}
                  onChange={(value) => onChange("mcpOAuthClientId", value)}
                  isRequired
                  isDisabled={busy}
                  fullWidth
                >
                  <Label>Client ID</Label>
                  <Input autoComplete="off" spellCheck={false} />
                </TextField>
                <TextField
                  className="kulo-form-field"
                  variant="secondary"
                  type="password"
                  value={draft.clientSecret}
                  onChange={(value) => onChange("clientSecret", value)}
                  isDisabled={busy}
                  fullWidth
                >
                  <Label>Client Secret</Label>
                  <Input autoComplete="new-password" spellCheck={false} />
                </TextField>
              </>
            ) : (
              <Disclosure>
                <Disclosure.Heading>
                  <Button size="sm" slot="trigger" variant="ghost" className="w-full justify-between">
                    {t("高级 OAuth 选项", "Advanced OAuth options")}
                    <Disclosure.Indicator />
                  </Button>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="kulo-form-stack pt-2">
                    <TextField
                      className="kulo-form-field"
                      variant="secondary"
                      value={draft.mcpOAuthClientId}
                      onChange={(value) => onChange("mcpOAuthClientId", value)}
                      isDisabled={busy}
                      fullWidth
                    >
                      <Label>Client ID</Label>
                      <Input autoComplete="off" spellCheck={false} />
                    </TextField>
                    {Boolean(draft.mcpOAuthClientId.trim()) && (
                      <TextField
                        className="kulo-form-field"
                        variant="secondary"
                        type="password"
                        value={draft.clientSecret}
                        onChange={(value) => onChange("clientSecret", value)}
                        isDisabled={busy}
                        fullWidth
                      >
                        <Label>Client Secret</Label>
                        <Input autoComplete="new-password" spellCheck={false} />
                      </TextField>
                    )}
                    <TextField
                      className="kulo-form-field"
                      variant="secondary"
                      value={draft.mcpOAuthScope}
                      onChange={(value) => onChange("mcpOAuthScope", value)}
                      isDisabled={busy}
                      fullWidth
                    >
                      <Label>Scope</Label>
                      <Input autoComplete="off" spellCheck={false} />
                    </TextField>
                    <TextField
                      className="kulo-form-field"
                      variant="secondary"
                      value={draft.mcpOAuthCallbackPort}
                      onChange={(value) => onChange("mcpOAuthCallbackPort", value)}
                      isDisabled={busy}
                      fullWidth
                    >
                      <Label>{t("回调端口", "Callback port")}</Label>
                      <Input inputMode="numeric" autoComplete="off" placeholder={t("默认自动分配", "Auto")} />
                    </TextField>
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            )
          )}
        </>
      ) : (
        <>
          <TextField
            className="kulo-form-field"
            variant="secondary"
            value={draft.mcpCommand}
            onChange={(value) => onChange("mcpCommand", value)}
            isRequired
            isDisabled={busy}
            fullWidth
          >
            <Label>{t("启动命令", "Command")}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder="npx" />
          </TextField>
          <TextField
            className="kulo-form-field"
            variant="secondary"
            value={draft.mcpArgsText}
            onChange={(value) => onChange("mcpArgsText", value)}
            isDisabled={busy}
            fullWidth
          >
            <Label>{t("启动参数（每行一项）", "Arguments (one per line)")}</Label>
            <TextArea rows={3} className="scrollbar font-mono" autoComplete="off" spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} />
          </TextField>
          <TextField
            className="kulo-form-field"
            variant="secondary"
            value={draft.mcpCwd}
            onChange={(value) => onChange("mcpCwd", value)}
            isDisabled={busy}
            fullWidth
          >
            <Label>{t("工作目录", "Working directory")}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder={t("可选绝对路径", "Optional absolute path")} />
          </TextField>
          {draft.credentialFields.map((field, index) => (
            <div key={field.key} role="group" aria-label={field.label.trim() || t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)} className="kulo-form-stack rounded-xl border border-border p-3">
              <div className="kulo-field-action-row">
                <TextField
                  className="kulo-form-field min-w-0 flex-1"
                  variant="secondary"
                  value={field.label}
                  onChange={(value) => updateEnvField(field.key, { label: value })}
                  isRequired
                  isDisabled={busy}
                  fullWidth
                >
                  <Label>{t(`环境变量 ${index + 1}`, `Env var ${index + 1}`)}</Label>
                  <Input className="kulo-field-action-input font-mono" maxLength={64} autoComplete="off" spellCheck={false} placeholder="API_TOKEN" />
                </TextField>
                <Button
                  size="sm"
                  variant="ghost"
                  className="kulo-field-action-button"
                  aria-label={t(`移除${field.label.trim() || `环境变量 ${index + 1}`}`, `Remove ${field.label.trim() || `env var ${index + 1}`}`)}
                  isDisabled={busy}
                  onPress={() => removeEnvField(field.key)}
                >
                  {t("移除", "Remove")}
                </Button>
              </div>
              <TextField
                className="kulo-form-field"
                variant="secondary"
                type="password"
                value={field.value}
                onChange={(value) => updateEnvField(field.key, { value })}
                isDisabled={busy}
                fullWidth
              >
                <Label>{t("变量值", "Value")}</Label>
                <Input autoComplete="new-password" spellCheck={false} />
              </TextField>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || draft.credentialFields.length >= 32}
            onPress={addEnvField}
          >
            {t("添加环境变量", "Add env var")}
          </Button>
        </>
      )}
    </form>
  );
}
