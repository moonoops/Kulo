import { translate as t, useI18n } from "../../kulo-i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Label,
  Spinner,
  Tabs,
  TextField,
} from "@heroui/react";
import type { KuloSettingsView } from "@kulo/protocol";
import { KuloApiError, kuloRest } from "../../kulo-api";
import { IdentityDocumentEditor } from "../../identity-document-editor";
import { SettingsList } from "./settings-layout";
import { useSettingsPending } from "./settings-save-activity";
import type { SettingsAssistantEntryIntent } from "./settings-assistant-actions";
import { RecentWorkPanel, RelationshipUpdateControls, usePersonalityControls } from "./personality-controls";
import { MemoryServicePanel } from "./memory-service-panel";
import { MEMORY_CONNECTION_FOCUS_EVENT, requestMemoryConnectionFocus } from "./memory-service-events";
import { recentWorkUpdateKey, type RecentWorkSource } from "./recent-work-updates";

type IdentityView = "identity" | "relationship" | "memory" | "recent";

export function IdentityModule({
  settings,
  onSettingsUpdated,
  onDirtyChange,
  entryIntent,
  onIntentHandled,
  topicId,
  recentWorkSource,
  connected = true,
}: {
  settings: KuloSettingsView;
  onSettingsUpdated: (next: KuloSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  entryIntent?: SettingsAssistantEntryIntent | null;
  onIntentHandled?: (id: string) => void;
  topicId?: string;
  recentWorkSource?: RecentWorkSource;
  connected?: boolean;
}) {
  useI18n();
  const presBlock = settings.blocks.presentation;
  const identityBlock = settings.blocks.identity;
  const [view, setView] = useState<IdentityView>("identity");
  const recentActive = view === "recent" && connected;
  const recentUpdateKey = useMemo(() => recentActive && recentWorkSource ? recentWorkUpdateKey(recentWorkSource, topicId) : undefined,
    [recentActive, topicId, recentWorkSource?.tickets, recentWorkSource?.topics, recentWorkSource?.projects]);
  const personality = usePersonalityControls(topicId, recentActive, recentUpdateKey);
  useEffect(() => {
    const showMemory = () => setView("memory");
    window.addEventListener(MEMORY_CONNECTION_FOCUS_EVENT, showMemory);
    return () => window.removeEventListener(MEMORY_CONNECTION_FOCUS_EVENT, showMemory);
  }, []);

  useEffect(() => {
    if (!entryIntent || entryIntent.module !== "identity") return;
    if (entryIntent.intent === "configure-memory") {
      setView("memory");
      requestMemoryConnectionFocus();
    } else if (entryIntent.intent === "edit-identity") setView("identity");
    else return;
    onIntentHandled?.(entryIntent.id);
  }, [entryIntent?.id, onIntentHandled]);

  const [presBaseRev, setPresBaseRev] = useState(presBlock.revision);
  const [presBaseValue, setPresBaseValue] = useState(presBlock.value);
  const [agentName, setAgentName] = useState(presBlock.value.agentName);
  const [presConflict, setPresConflict] = useState(false);

  const [identityDirty, setIdentityDirty] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [relationshipDirty, setRelationshipDirty] = useState(false);
  const [relationshipBusy, setRelationshipBusy] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [presError, setPresError] = useState<string>();
  const presentationRef = useRef({ revision: presBaseRev, value: presBaseValue, agentName });
  presentationRef.current = { revision: presBaseRev, value: presBaseValue, agentName };

  const presDirty = agentName !== presBaseValue.agentName;

  const anyDirty = presDirty || identityDirty || relationshipDirty || memoryDirty || personality.dirty;
  const tabBusy = identityBusy || relationshipBusy || memoryBusy;
  useSettingsPending(personality.saving || busy);

  useEffect(() => {
    onDirtyChange?.(anyDirty);
    return () => onDirtyChange?.(false);
  }, [anyDirty, onDirtyChange]);

  useEffect(() => {
    if (presBlock.revision === presBaseRev) return;
    if (!presDirty) {
      setAgentName(presBlock.value.agentName);
      setPresBaseRev(presBlock.revision);
      setPresBaseValue(presBlock.value);
      setPresConflict(false);
    } else {
      setPresConflict(true);
    }
  }, [presBlock.revision, presBlock.value, presBaseRev, presDirty]);

  const acceptPresentation = (next: KuloSettingsView, replaceName: boolean) => {
    const block = next.blocks.presentation;
    presentationRef.current = { revision: block.revision, value: block.value, agentName: replaceName ? block.value.agentName : presentationRef.current.agentName };
    setPresBaseRev(block.revision);
    setPresBaseValue(block.value);
    if (replaceName) setAgentName(block.value.agentName);
    onSettingsUpdated(next);
  };

  const reloadLatest = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const latest = await kuloRest.getSettings();
      acceptPresentation(latest, true);
      setPresConflict(false);
      setPresError(undefined);
    } catch (err) {
      setPresError(err instanceof Error ? err.message : t("加载最新配置失败", "Failed to load the latest settings"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const savePres = async (retry = false) => {
    const draft = presentationRef.current;
    if (busyRef.current || draft.agentName === draft.value.agentName) return;
    const name = draft.agentName.trim();
    if (!name || name.length > 80) {
      setPresError(t("显示名称须为1至80个字符。", "The display name must contain 1 to 80 characters."));
      return;
    }
    const conflict = presConflict || draft.revision !== presBlock.revision;
    if (conflict && !retry) { setPresConflict(true); return; }
    busyRef.current = true;
    setBusy(true);
    try {
      let base = draft;
      if (conflict) {
        const latest = await kuloRest.getSettings();
        acceptPresentation(latest, false);
        base = presentationRef.current;
      }
      if (name === base.value.agentName) {
        setAgentName(name);
        presentationRef.current = { ...base, agentName: name };
        setPresConflict(false);
        setPresError(undefined);
        return;
      }
      const res = await kuloRest.saveSettingsBlock(
        "presentation",
        base.revision,
        { ...base.value, agentName: name },
      );
      acceptPresentation(res.settings, true);
      setPresConflict(false);
      setPresError(undefined);
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
        setPresConflict(true);
        setPresError(t("显示名称已被其他会话更新，本地修改已保留。", "The display name changed in another window. Your draft is preserved."));
      } else {
        setPresError(err instanceof Error ? err.message : t("保存失败", "Failed to save"));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Tabs
        selectedKey={view}
        onSelectionChange={(key) => setView(String(key) as IdentityView)}
        className="kulo-settings-form kulo-identity-tabs gap-7"
      >
        <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0" inert={tabBusy || undefined} aria-busy={tabBusy || undefined}>
          <Tabs.List aria-label={t("记忆视图", "Memory views")} className="w-max">
            <Tabs.Tab id="identity" className="w-auto shrink-0 whitespace-nowrap px-1.5 text-sm sm:px-3">
              {t("身份约定", "Identity")}<Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="relationship" className="w-auto shrink-0 whitespace-nowrap px-1.5 text-sm sm:px-3">
              {t("协作关系", "Collaboration")}<Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="memory" className="w-auto shrink-0 whitespace-nowrap px-1.5 text-sm sm:px-3">
              {t("长期记忆", "Long-term memory")}<Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="recent" className="w-auto shrink-0 whitespace-nowrap px-1.5 text-sm sm:px-3">
              {t("近期工作", "Recent work")}<Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        {/* Each module keeps its own draft while another tab is active. */}
        <Tabs.Panel
          id="identity"
          shouldForceMount
          className="min-h-0 flex-1 data-[inert=true]:hidden"
        >
          <div className="kulo-settings-form gap-6">
          <div className="kulo-form-stack">
            <SettingsList label={t("显示名称", "Display name")}>
              <TextField
                isRequired maxLength={80} value={agentName}
                onChange={(value) => { presentationRef.current.agentName = value; setAgentName(value); }}
                isReadOnly={busy} isInvalid={Boolean(presError && !presConflict)}
                className="kulo-settings-row" fullWidth
              >
                <Label className="kulo-field-label">{t("显示名称", "Display name")}{busy && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}</Label>
                <Input variant="secondary" onBlur={() => void savePres()} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void savePres(); }
                }} />
              </TextField>
            </SettingsList>
            {(presError || presConflict) && (
              <Alert status={presConflict ? "warning" : "danger"} role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl p-3">
                <Alert.Indicator />
                <Alert.Content className="flex-1 text-sm">{presError ?? t("显示名称已被其他会话更新，本地修改已保留。", "The display name changed in another window. Your draft is preserved.")}</Alert.Content>
                <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void savePres(true)}>{t("重试", "Retry")}</Button>
                {presConflict && <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void reloadLatest()}>{t("使用最新值", "Use latest")}</Button>}
              </Alert>
            )}
          </div>
          {!personality.snapshot && personality.error && <Alert status="danger" className="rounded-xl p-3">
            <Alert.Indicator />
            <Alert.Content className="flex-1 text-sm">{personality.error}</Alert.Content>
            <Button variant="secondary" size="sm" onPress={() => void personality.refresh()}>{t("重试", "Retry")}</Button>
          </Alert>}
          <IdentityDocumentEditor
            directoryRevision={identityBlock.directoryRevision}
            file="identity-agreement.md"
            readFile={kuloRest.readIdentityAgreement}
            loadPreset={kuloRest.readIdentityPreset}
            identityProposal={personality.snapshot?.identityProposal}
            onDismissProposal={personality.dismissProposal}
            onSaved={() => void personality.refresh()}
            onDirtyChange={setIdentityDirty}
            onBusyChange={setIdentityBusy}
          />
          </div>
        </Tabs.Panel>

        <Tabs.Panel
          id="relationship"
          shouldForceMount
          className="min-h-0 flex-1 data-[inert=true]:hidden"
        >
          <div className="kulo-settings-form gap-7">
          <RelationshipUpdateControls controls={personality} />
          <IdentityDocumentEditor
            directoryRevision={identityBlock.directoryRevision}
            file="relationship.md"
            directSave
            onSaved={() => void personality.refresh()}
            refreshKey={personality.snapshot?.relationshipStatus.lastUpdatedAt ?? undefined}
            onDirtyChange={setRelationshipDirty}
            onBusyChange={setRelationshipBusy}
          />
          </div>
        </Tabs.Panel>

        <Tabs.Panel
          id="memory"
          shouldForceMount
          className="min-h-0 flex-1 data-[inert=true]:hidden"
        >
          <MemoryServicePanel settings={settings} connected={connected} onSettingsUpdated={onSettingsUpdated} onDirtyChange={setMemoryDirty} onBusyChange={setMemoryBusy} />
        </Tabs.Panel>
        <Tabs.Panel id="recent" shouldForceMount className="min-h-0 flex-1 data-[inert=true]:hidden">
          <RecentWorkPanel controls={personality} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
