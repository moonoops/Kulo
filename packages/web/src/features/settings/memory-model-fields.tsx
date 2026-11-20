import { Input, Label, ListBox, Select, TextField } from "@heroui/react";
import type {
  HindsightEmbeddingsProvider,
  HindsightModelProvider,
  HindsightRerankerProvider,
} from "@kulo/protocol";
import { translate as t, useI18n } from "../../kulo-i18n";
import { SettingsList } from "./settings-layout";
import {
  CUSTOM_MODEL_OPTION,
  DEFAULT_ONNX_EMBEDDING_DIMENSIONS,
  DEFAULT_ONNX_EMBEDDING_MODEL,
  ONNX_EMBEDDING_PRESETS,
  ONNX_RERANKER_PRESETS,
  SEPARATE_CONNECTION_OPTION,
  defaultEmbeddingsModelFor,
  defaultRerankerModelFor,
  directModelProviders,
  embeddingsProviders,
  embeddingsSupportsBaseUrl,
  embeddingsUsesApiKey,
  rerankerProviders,
  rerankerSupportsBaseUrl,
  rerankerUsesApiKey,
  reusableApiConnectionsForEmbeddings,
  reusableApiConnectionsForReranker,
  type MemoryKuloConnectionOption,
  type MemoryModelsDraft,
} from "./memory-service-models";

export function MemoryModelFields({
  draft,
  connections,
  disabled,
  layout,
  onChange,
}: {
  draft: MemoryModelsDraft;
  connections: MemoryKuloConnectionOption[];
  disabled: boolean;
  layout: "settings" | "form";
  onChange: (next: MemoryModelsDraft) => void;
}) {
  useI18n();
  const fieldVariant = layout === "settings" ? "secondary" : "primary";
  const rowClass = layout === "settings" ? "kulo-settings-row" : "kulo-form-field";
  const choiceClass = layout === "settings" ? "kulo-settings-row kulo-settings-row--choice" : "kulo-form-field";

  const selectedConnection = draft.provider === "kulo"
    ? connections.find((item) => item.id === draft.connectionId)
    : undefined;
  const selectableModels = selectedConnection?.models.length
    ? [...new Set([...selectedConnection.models, ...(draft.model.trim() ? [draft.model.trim()] : [])])]
    : [];
  const sourceValue = selectedConnection ? selectedConnection.id : SEPARATE_CONNECTION_OPTION;

  const embReusable = reusableApiConnectionsForEmbeddings(draft.embeddingsProvider, connections);
  const embSelectedConnection = embReusable.find((item) => item.id === draft.embeddingsConnectionId);
  const embOnnxPreset = ONNX_EMBEDDING_PRESETS.find((item) => item.id === draft.embeddingsModel);
  const embOnnxSelectValue = embOnnxPreset ? embOnnxPreset.id : CUSTOM_MODEL_OPTION;

  const rrReusable = reusableApiConnectionsForReranker(draft.rerankerProvider, connections);
  const rrSelectedConnection = rrReusable.find((item) => item.id === draft.rerankerConnectionId);
  const rrOnnxPreset = ONNX_RERANKER_PRESETS.find((item) => item.id === draft.rerankerModel);
  const rrOnnxSelectValue = rrOnnxPreset ? rrOnnxPreset.id : CUSTOM_MODEL_OPTION;

  const understandingFields = (
    <>
      {connections.length > 0 && (
        <Select
          variant={fieldVariant}
          className={rowClass}
          value={sourceValue}
          onChange={(value) => {
            const key = String(value ?? "");
            const matched = connections.find((item) => item.id === key);
            if (matched) {
              onChange({
                ...draft,
                provider: "kulo",
                connectionId: matched.id,
                baseUrl: "",
                model: matched.model || matched.models[0] || "",
              });
            } else {
              onChange({
                ...draft,
                provider: draft.provider === "kulo" ? "openai" : draft.provider,
                connectionId: "",
                baseUrl: "",
                model: "",
              });
            }
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("理解模型来源", "Understanding model source")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {connections.map((connection) => (
                <ListBox.Item key={connection.id} id={connection.id} textValue={connection.label}>
                  {connection.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <ListBox.Item id={SEPARATE_CONNECTION_OPTION} textValue={t("单独配置", "Configure separately")}>
                {t("单独配置", "Configure separately")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {!selectedConnection && (
        <Select
          variant={fieldVariant}
          className={choiceClass}
          value={draft.provider === "kulo" ? "openai" : draft.provider}
          onChange={(value) => {
            if (value) {
              onChange({
                ...draft,
                provider: String(value) as HindsightModelProvider,
                connectionId: "",
                baseUrl: "",
                model: "",
              });
            }
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("理解模型供应商", "Understanding provider")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {directModelProviders().map((provider) => (
                <ListBox.Item key={provider.id} id={provider.id} textValue={provider.label}>
                  {provider.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {selectableModels.length > 0 ? (
        <Select
          variant={fieldVariant}
          className={rowClass}
          placeholder={t("未选择", "Not selected")}
          value={draft.model && selectableModels.includes(draft.model) ? draft.model : null}
          onChange={(value) => {
            if (value) onChange({ ...draft, model: String(value) });
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("理解模型", "Understanding model")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {selectableModels.map((modelId) => (
                <ListBox.Item key={modelId} id={modelId} textValue={modelId}>
                  {modelId}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.model}
          onChange={(model) => onChange({ ...draft, model })}
          isRequired
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("理解模型", "Understanding model")}</Label>
          <Input spellCheck={false} />
        </TextField>
      )}
      {!selectedConnection && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.baseUrl}
          onChange={(baseUrl) => onChange({ ...draft, baseUrl, connectionId: "" })}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("模型地址", "Model URL")}</Label>
          <Input
            type="url"
            spellCheck={false}
            placeholder={draft.provider === "ollama" ? "http://127.0.0.1:11434" : t("默认地址", "Default URL")}
          />
        </TextField>
      )}
    </>
  );

  const embeddingFields = (
    <>
      <Select
        variant={fieldVariant}
        className={choiceClass}
        value={draft.embeddingsProvider}
        onChange={(value) => {
          if (!value) return;
          const nextProvider = String(value) as HindsightEmbeddingsProvider;
          const nextModel = defaultEmbeddingsModelFor(nextProvider);
          onChange({
            ...draft,
            embeddingsProvider: nextProvider,
            embeddingsConnectionId: "",
            embeddingsBaseUrl: "",
            embeddingsModel: nextModel,
            embeddingsDimensions: nextProvider === "onnx" && nextModel === DEFAULT_ONNX_EMBEDDING_MODEL
              ? String(DEFAULT_ONNX_EMBEDDING_DIMENSIONS)
              : "",
          });
        }}
        isDisabled={disabled}
        fullWidth
      >
        <Label>{t("向量模型（Embedding）", "Embedding provider")}</Label>
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover>
          <ListBox>
            {embeddingsProviders().map((provider) => (
              <ListBox.Item key={provider.id} id={provider.id} textValue={provider.label}>
                {provider.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {embeddingsUsesApiKey(draft.embeddingsProvider) && embReusable.length > 0 && (
        <Select
          variant={fieldVariant}
          className={rowClass}
          value={embSelectedConnection ? embSelectedConnection.id : SEPARATE_CONNECTION_OPTION}
          onChange={(value) => {
            const matched = embReusable.find((item) => item.id === String(value ?? ""));
            onChange({
              ...draft,
              embeddingsConnectionId: matched ? matched.id : "",
              embeddingsBaseUrl: matched?.baseUrl ?? "",
            });
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("向量凭据来源", "Embedding credentials")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={SEPARATE_CONNECTION_OPTION} textValue={t("单独输入密钥", "Enter API key separately")}>
                {t("单独输入密钥", "Enter API key separately")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {embReusable.map((connection) => (
                <ListBox.Item key={connection.id} id={connection.id} textValue={connection.label}>
                  {connection.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {draft.embeddingsProvider === "onnx" && (
        <Select
          variant={fieldVariant}
          className={rowClass}
          value={embOnnxSelectValue}
          onChange={(value) => {
            const key = String(value ?? "");
            if (key === CUSTOM_MODEL_OPTION) {
              onChange({ ...draft, embeddingsModel: "", embeddingsDimensions: "" });
              return;
            }
            const preset = ONNX_EMBEDDING_PRESETS.find((item) => item.id === key);
            if (preset) {
              onChange({
                ...draft,
                embeddingsModel: preset.id,
                embeddingsDimensions: preset.dimensions ? String(preset.dimensions) : "",
              });
            }
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("向量模型名称", "Embedding model")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {ONNX_EMBEDDING_PRESETS.map((preset) => (
                <ListBox.Item key={preset.id} id={preset.id} textValue={preset.label}>
                  {preset.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <ListBox.Item id={CUSTOM_MODEL_OPTION} textValue={t("自定义模型", "Custom model")}>
                {t("自定义模型", "Custom model")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {((draft.embeddingsProvider === "onnx" && embOnnxSelectValue === CUSTOM_MODEL_OPTION)
        || (draft.embeddingsProvider !== "onnx" && draft.embeddingsProvider !== "tei")) && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.embeddingsModel}
          onChange={(embeddingsModel) => onChange({ ...draft, embeddingsModel })}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("向量模型标识", "Embedding model ID")}</Label>
          <Input spellCheck={false} placeholder={defaultEmbeddingsModelFor(draft.embeddingsProvider)} />
        </TextField>
      )}
      {embeddingsSupportsBaseUrl(draft.embeddingsProvider) && !embSelectedConnection && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.embeddingsBaseUrl}
          onChange={(embeddingsBaseUrl) => onChange({ ...draft, embeddingsBaseUrl, embeddingsConnectionId: "" })}
          isRequired={draft.embeddingsProvider === "tei"}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("向量服务地址", "Embedding service URL")}</Label>
          <Input
            type="url"
            spellCheck={false}
            placeholder={draft.embeddingsProvider === "tei" ? "http://127.0.0.1:8080" : t("默认地址", "Default URL")}
          />
        </TextField>
      )}
      {((draft.embeddingsProvider === "onnx" && embOnnxSelectValue === CUSTOM_MODEL_OPTION)
        || (draft.embeddingsProvider !== "onnx" && draft.embeddingsProvider !== "tei")) && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.embeddingsDimensions}
          onChange={(embeddingsDimensions) => onChange({ ...draft, embeddingsDimensions })}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("向量维度", "Embedding dimensions")}</Label>
          <Input inputMode="numeric" spellCheck={false} placeholder={t("自动", "Auto")} />
        </TextField>
      )}
    </>
  );

  const rerankerFields = (
    <>
      <Select
        variant={fieldVariant}
        className={choiceClass}
        value={draft.rerankerProvider}
        onChange={(value) => {
          if (!value) return;
          const nextProvider = String(value) as HindsightRerankerProvider;
          onChange({
            ...draft,
            rerankerProvider: nextProvider,
            rerankerConnectionId: "",
            rerankerBaseUrl: "",
            rerankerModel: defaultRerankerModelFor(nextProvider),
          });
        }}
        isDisabled={disabled}
        fullWidth
      >
        <Label>{t("重排模型（Rerank）", "Rerank provider")}</Label>
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover>
          <ListBox>
            {rerankerProviders().map((provider) => (
              <ListBox.Item key={provider.id} id={provider.id} textValue={provider.label}>
                {provider.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {rerankerUsesApiKey(draft.rerankerProvider) && rrReusable.length > 0 && (
        <Select
          variant={fieldVariant}
          className={rowClass}
          value={rrSelectedConnection ? rrSelectedConnection.id : SEPARATE_CONNECTION_OPTION}
          onChange={(value) => {
            const matched = rrReusable.find((item) => item.id === String(value ?? ""));
            onChange({
              ...draft,
              rerankerConnectionId: matched ? matched.id : "",
              rerankerBaseUrl: matched?.baseUrl ?? "",
            });
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("重排凭据来源", "Rerank credentials")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={SEPARATE_CONNECTION_OPTION} textValue={t("单独输入密钥", "Enter API key separately")}>
                {t("单独输入密钥", "Enter API key separately")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {rrReusable.map((connection) => (
                <ListBox.Item key={connection.id} id={connection.id} textValue={connection.label}>
                  {connection.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {draft.rerankerProvider === "onnx" && (
        <Select
          variant={fieldVariant}
          className={rowClass}
          value={rrOnnxSelectValue}
          onChange={(value) => {
            const key = String(value ?? "");
            if (key === CUSTOM_MODEL_OPTION) {
              onChange({ ...draft, rerankerModel: "" });
              return;
            }
            onChange({ ...draft, rerankerModel: key });
          }}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("重排模型名称", "Rerank model")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {ONNX_RERANKER_PRESETS.map((preset) => (
                <ListBox.Item key={preset.id} id={preset.id} textValue={preset.label}>
                  {preset.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <ListBox.Item id={CUSTOM_MODEL_OPTION} textValue={t("自定义模型", "Custom model")}>
                {t("自定义模型", "Custom model")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      {((draft.rerankerProvider === "onnx" && rrOnnxSelectValue === CUSTOM_MODEL_OPTION)
        || (draft.rerankerProvider !== "onnx" && draft.rerankerProvider !== "rrf" && draft.rerankerProvider !== "tei")) && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.rerankerModel}
          onChange={(rerankerModel) => onChange({ ...draft, rerankerModel })}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("重排模型标识", "Rerank model ID")}</Label>
          <Input spellCheck={false} placeholder={defaultRerankerModelFor(draft.rerankerProvider)} />
        </TextField>
      )}
      {rerankerSupportsBaseUrl(draft.rerankerProvider) && !rrSelectedConnection && (
        <TextField
          variant={fieldVariant}
          className={rowClass}
          value={draft.rerankerBaseUrl}
          onChange={(rerankerBaseUrl) => onChange({ ...draft, rerankerBaseUrl, rerankerConnectionId: "" })}
          isRequired={draft.rerankerProvider === "tei"}
          isDisabled={disabled}
          fullWidth
        >
          <Label>{t("重排服务地址", "Rerank service URL")}</Label>
          <Input
            type="url"
            spellCheck={false}
            placeholder={draft.rerankerProvider === "tei" ? "http://127.0.0.1:8081" : t("默认地址", "Default URL")}
          />
        </TextField>
      )}
    </>
  );

  if (layout === "settings") {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <SettingsList label={t("记忆模型配置", "Memory model configuration")}>
          {understandingFields}
          {embeddingFields}
          {rerankerFields}
        </SettingsList>
      </div>
    );
  }

  return (
    <div className="kulo-form-stack">
      {understandingFields}
      {embeddingFields}
      {rerankerFields}
    </div>
  );
}
