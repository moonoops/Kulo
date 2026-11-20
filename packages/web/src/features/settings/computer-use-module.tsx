import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Label, Skeleton, Spinner, Switch, Table } from "@heroui/react";
import { redactSecrets, type ComputerUseSettings, type EnvNodeDescriptor } from "@kulo/protocol";
import { translate, useI18n } from "../../kulo-i18n";
import { kuloRest } from "../../kulo-api";
import { useSettingsPending } from "./settings-save-activity";
import { SettingsList, SettingsSection } from "./settings-layout";

export interface ComputerUseSnapshotState {
  revision: number;
  computerUse: ComputerUseSettings;
}

const DEFAULT_COMPUTER_USE: ComputerUseSettings = { browserEnabled: true, desktopEnabled: true };
const commandId = () => `computer-use-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const report = (cause: unknown) => redactSecrets(cause instanceof Error ? cause.message : translate("电脑操控设置保存失败，请重试。", "Failed to save Computer Use settings. Please retry."));

export function acceptComputerUseState(
  previous: ComputerUseSnapshotState | null,
  next: ComputerUseSnapshotState,
): ComputerUseSnapshotState {
  return !previous || next.revision > previous.revision ? next : previous;
}

function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

export function ComputerUseModule({
  state: incoming,
  envs,
  connected,
  disabled = false,
  onRefresh,
}: {
  state: ComputerUseSnapshotState | null;
  envs: EnvNodeDescriptor[];
  connected: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}) {
  return <ComputerUseWorkspace key={incoming === null ? "unloaded" : "loaded"} state={incoming} envs={envs} connected={connected} disabled={disabled} onRefresh={onRefresh} />;
}

function ComputerUseWorkspace({
  state: incoming,
  envs,
  connected,
  disabled = false,
  onRefresh,
}: {
  state: ComputerUseSnapshotState | null;
  envs: EnvNodeDescriptor[];
  connected: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ComputerUseSnapshotState | null>(incoming);
  const [busy, setBusy] = useState<"browser" | "desktop">();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const switches = useRef(new Map<"browser" | "desktop", HTMLElement>());
  useSettingsPending(Boolean(busy));

  const accept = useCallback((next: ComputerUseSnapshotState) => {
    setState((previous) => acceptComputerUseState(previous, next));
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (incoming) accept(incoming); }, [incoming, accept]);

  const current = state?.computerUse ?? DEFAULT_COMPUTER_USE;
  const blocked = !connected || disabled || !state || Boolean(busy);
  const computers = envs.filter((env) => env.executionKind !== "native-device");
  const hasBrowserDevice = computers.some((env) => env.online && env.capabilities.includes("agent-browser"));
  const hasDesktopDevice = computers.some((env) => env.online && env.capabilities.includes("agent-desktop"));

  const toggle = async (target: "browser" | "desktop", enabled: boolean) => {
    if (!state || !connected || disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(target);
    setError(undefined);
    const nextSettings: ComputerUseSettings = target === "browser"
      ? { browserEnabled: enabled, desktopEnabled: current.desktopEnabled }
      : { browserEnabled: current.browserEnabled, desktopEnabled: enabled };
    try {
      const saved = await kuloRest.updateComputerUse({
        ...nextSettings,
        expectedRevision: state.revision,
        commandId: commandId(),
      });
      if (mounted.current) {
        accept(saved);
        onRefresh();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(report(cause));
        onRefresh();
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(undefined);
        requestAnimationFrame(() => switches.current.get(target)?.querySelector<HTMLInputElement>("input")?.focus());
      }
    }
  };

  const controlStatus = (enabled: boolean, supported: boolean) => {
    if (!enabled) return { label: t("已停用", "Disabled"), color: "default" as const };
    if (!computers.length) return { label: t("已启用", "Enabled"), color: "success" as const };
    if (!supported) return { label: t("设备未就绪", "Device unavailable"), color: "warning" as const };
    return { label: t("可用", "Ready"), color: "success" as const };
  };

  const browserStatus = controlStatus(current.browserEnabled, hasBrowserDevice);
  const desktopStatus = controlStatus(current.desktopEnabled, hasDesktopDevice);

  return (
    <div className="flex min-w-0 flex-col gap-6" aria-busy={Boolean(busy) || undefined}>
      <SettingsSection title={t("电脑操控", "Computer Use")}>
        {error && (
          <Alert status="danger" role="alert">
            <Alert.Content>{error}</Alert.Content>
            <Button size="sm" variant="ghost" isDisabled={!connected || disabled || Boolean(busy)} onPress={onRefresh}>{t("刷新", "Refresh")}</Button>
          </Alert>
        )}
        {!state ? (
          <div className="kulo-table-empty-state w-full gap-4" role="status" aria-label={t("加载电脑操控设置", "Loading Computer Use settings")}>
            <Skeleton animationType="none" className="h-3 w-32" />
            <Skeleton animationType="none" className="h-3 w-16" />
          </div>
        ) : (
          <SettingsList label={t("电脑操控开关", "Computer Use controls")}>
            <Switch
              ref={(node) => { if (node) switches.current.set("browser", node); else switches.current.delete("browser"); }}
              className="w-full"
              aria-label={t("启用浏览器操控", "Enable browser control")}
              isSelected={current.browserEnabled}
              isDisabled={blocked}
              onChange={(enabled) => void toggle("browser", enabled)}
            >
              <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
                <div className="flex min-w-0 items-center gap-2">
                  <Label className="text-sm font-normal text-foreground">{t("浏览器操控", "Browser control")}</Label>
                  <Chip size="sm" variant="soft" color={browserStatus.color}>{browserStatus.label}</Chip>
                  {busy === "browser" && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
                </div>
                <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
              </Switch.Content>
            </Switch>
            <Switch
              ref={(node) => { if (node) switches.current.set("desktop", node); else switches.current.delete("desktop"); }}
              className="w-full"
              aria-label={t("启用桌面操控", "Enable desktop control")}
              isSelected={current.desktopEnabled}
              isDisabled={blocked}
              onChange={(enabled) => void toggle("desktop", enabled)}
            >
              <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
                <div className="flex min-w-0 items-center gap-2">
                  <Label className="text-sm font-normal text-foreground">{t("桌面操控", "Desktop control")}</Label>
                  <Chip size="sm" variant="soft" color={desktopStatus.color}>{desktopStatus.label}</Chip>
                  {busy === "desktop" && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
                </div>
                <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
              </Switch.Content>
            </Switch>
          </SettingsList>
        )}
      </SettingsSection>
      <SettingsSection title={t("执行设备", "Execution devices")}>
        <Table variant="secondary" className="kulo-settings-table kulo-capabilities-table">
          <Table.ScrollContainer className="kulo-settings-table-scroll">
            <Table.Content aria-label={t("电脑操控设备列表", "Computer Use devices")} selectionMode="none" keyboardNavigationBehavior="tab" className="kulo-settings-table-content">
              <Table.Header>
                <Table.Column id="name" isRowHeader className="kulo-settings-table-column">{t("设备", "Device")}</Table.Column>
                <Table.Column id="platform" className="kulo-settings-table-column kulo-settings-table-meta">{t("系统", "Platform")}</Table.Column>
                <Table.Column id="capabilities" className="kulo-settings-table-column kulo-settings-table-meta">{t("支持能力", "Capabilities")}</Table.Column>
                <Table.Column id="status" className="kulo-settings-table-column kulo-settings-table-meta">{t("状态", "Status")}</Table.Column>
              </Table.Header>
              <Table.Body renderEmptyState={() => <div className="kulo-table-empty-state">{t("暂无电脑设备", "No computer devices")}</div>}>
                {computers.map((env) => {
                  const caps: string[] = [];
                  if (env.capabilities.includes("agent-browser")) caps.push(t("浏览器", "Browser"));
                  if (env.capabilities.includes("agent-desktop")) caps.push(t("桌面", "Desktop"));
                  return (
                    <Table.Row key={env.id} id={env.id} textValue={env.name}>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-primary">
                        <span className="kulo-item-title">{env.name}</span>
                      </Table.Cell>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                        <span className="text-sm">{platformLabel(env.platform)}</span>
                      </Table.Cell>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                        {caps.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {caps.map((label) => <Chip key={label} size="sm" variant="tertiary">{label}</Chip>)}
                          </div>
                        ) : (
                          <span className="text-sm text-muted">—</span>
                        )}
                      </Table.Cell>
                      <Table.Cell className="kulo-settings-table-cell kulo-settings-table-meta">
                        <Chip size="sm" variant="soft" color={env.online ? "success" : "default"}>{env.online ? t("在线", "Online") : t("离线", "Offline")}</Chip>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </SettingsSection>
    </div>
  );
}
