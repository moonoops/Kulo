import { useState } from "react";
import { Alert, Button, Chip, Label, Spinner, Switch } from "@heroui/react";
import { redactSensitiveText } from "@kulo/protocol";
import { translate as t, useI18n } from "../../kulo-i18n";
import { KuloIcon } from "../../kulo-icon";
import { kuloRest, type AssistantWorkspaceView } from "../../kulo-api";
import { SettingsList, SettingsSection } from "./settings-layout";

function shortMutedAppLabel(appId: string): string {
  const trimmed = appId.trim();
  const tail = trimmed.split(".").filter(Boolean).at(-1);
  return tail || trimmed;
}

export function AssistantAwarenessSection({
  assistant,
  connected,
  localEnvId,
  onUpdated,
  onOpenHomeAssistant,
}: {
  assistant: AssistantWorkspaceView;
  connected: boolean;
  localEnvId?: string;
  onUpdated?: (next: AssistantWorkspaceView) => void;
  onOpenHomeAssistant?: () => void;
}) {
  useI18n();
  const [busyNotif, setBusyNotif] = useState(false);
  const [busySpark, setBusySpark] = useState(false);
  const [recheckingSpark, setRecheckingSpark] = useState(false);
  const [busyLark, setBusyLark] = useState(false);
  const [recheckingLark, setRecheckingLark] = useState(false);
  const [unmutingApp, setUnmutingApp] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);

  const isLocalSource = (envId: string) => envId === "local" || Boolean(localEnvId && envId === localEnvId);
  const macSources = assistant.sources.filter((source) => source.platform === "darwin");
  const grantedSources = macSources.filter((source) => source.permission === "granted");
  const fdaSources = macSources.filter((source) => source.permission === "full_disk_access_required");
  const localNeedsFda = fdaSources.some((source) => isLocalSource(source.envId));
  const remoteFdaNames = fdaSources.filter((source) => !isLocalSource(source.envId)).map((source) => source.envName || source.envId);
  const errorSource = macSources.find((source) => source.permission === "unsupported_schema" || source.permission === "error");

  const notifStatus: { color: "success" | "warning" | "danger" | "default"; label: string } = !assistant.enabled
    ? { color: "default", label: t("未开启", "Off") }
    : grantedSources.length > 0 && fdaSources.length === 0
      ? {
          color: "success",
          label: grantedSources.length > 1
            ? t(`已连接 · ${grantedSources.length} 台 Mac`, `Connected · ${grantedSources.length} Macs`)
            : t("已连接", "Connected"),
        }
      : grantedSources.length > 0 && fdaSources.length > 0
        ? {
            color: "warning",
            label: t(`已连接 ${grantedSources.length} 台 · ${fdaSources.length} 台待授权`, `${grantedSources.length} connected · ${fdaSources.length} needs access`),
          }
        : fdaSources.length > 0
          ? { color: "warning", label: t("需要完全磁盘访问权限", "Full Disk Access required") }
          : errorSource
            ? { color: "danger", label: t("需要处理", "Needs attention") }
            : macSources.length === 0
              ? { color: "default", label: t("等待 Mac 在线", "Waiting for a Mac") }
              : { color: "default", label: t("已开启", "Enabled") };

  const toggleNotifications = async (enabled: boolean) => {
    if (!connected || busyNotif) return;
    setBusyNotif(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantNotifications({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新通知感知状态失败", "Failed to update notification capture")));
    } finally {
      setBusyNotif(false);
    }
  };

  const unmuteApp = async (appId: string) => {
    if (!connected || unmutingApp) return;
    setUnmutingApp(appId);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantNotifications({ unmuteApp: appId });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("取消屏蔽失败", "Failed to unmute app")));
    } finally {
      setUnmutingApp(null);
    }
  };

  const openFdaSettings = async () => {
    if (!connected || openingSettings) return;
    setOpeningSettings(true);
    setSectionError(null);
    try {
      await kuloRest.openConnectionPermissionSettings("full-disk-access");
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("无法打开系统设置", "Failed to open System Settings")));
    } finally {
      setOpeningSettings(false);
    }
  };

  const toggleSpark = async (enabled: boolean) => {
    if (!connected || busySpark) return;
    setBusySpark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantSpark({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新 Spark Mail 状态失败", "Failed to update Spark Mail")));
    } finally {
      setBusySpark(false);
    }
  };

  const recheckSpark = async () => {
    if (!connected || busySpark) return;
    setBusySpark(true);
    setRecheckingSpark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantSpark({ enabled: true });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("检测 Spark Mail 状态失败", "Failed to check Spark Mail status")));
    } finally {
      setBusySpark(false);
      setRecheckingSpark(false);
    }
  };

  const toggleLark = async (enabled: boolean) => {
    if (!connected || busyLark) return;
    setBusyLark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantLark({ enabled });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("更新飞书桥接状态失败", "Failed to update Lark bridge")));
    } finally {
      setBusyLark(false);
    }
  };

  const recheckLark = async () => {
    if (!connected || busyLark) return;
    setBusyLark(true);
    setRecheckingLark(true);
    setSectionError(null);
    try {
      const next = await kuloRest.configureAssistantLark({ enabled: true });
      onUpdated?.(next);
    } catch (cause) {
      setSectionError(redactSensitiveText(cause instanceof Error ? cause.message : t("检测飞书状态失败", "Failed to check Lark status")));
    } finally {
      setBusyLark(false);
      setRecheckingLark(false);
    }
  };

  const spark = assistant.spark;
  const sparkStatus: { color: "success" | "warning" | "default"; label: string } | null = spark
    ? !spark.enabled
      ? { color: "default", label: t("未开启", "Off") }
      : spark.available
        ? {
            color: "success",
            label: spark.accountCount
              ? t(`已连接 · ${spark.accountCount} 账号`, `Connected · ${spark.accountCount}`)
              : t("已连接", "Connected"),
          }
        : { color: "warning", label: t("需开启 Spark CLI", "Enable Spark CLI") }
    : null;

  const ha = assistant.homeAssistant;
  const haStatus: { color: "success" | "warning" | "default"; label: string } | null = ha
    ? ha.connected
      ? {
          color: "success",
          label: ha.curatedEntities
            ? t(`已连接 · ${ha.curatedEntities} 设备`, `Connected · ${ha.curatedEntities}`)
            : t("已连接", "Connected"),
        }
      : ha.enabled && ha.error
        ? { color: "warning", label: t("需要处理", "Needs attention") }
        : { color: "default", label: t("未连接", "Not connected") }
    : null;

  const lark = assistant.lark;
  const larkReadyProfiles = lark ? lark.profiles.filter((p) => p.ready) : [];
  const larkReadyCount = larkReadyProfiles.length;
  const larkHasImPartial = larkReadyProfiles.some((p) => p.im?.coverage === "partial" || p.im?.status === "partial");
  const larkCalendarScopeMissing = larkReadyProfiles.some(
    (p) => p.im?.status === "ok" && p.calendar?.status === "missing_scope",
  );
  const larkStatus: { color: "success" | "warning" | "default"; label: string } | null = lark
    ? !lark.enabled
      ? { color: "default", label: t("未开启", "Off") }
      : !lark.cliAvailable
        ? { color: "warning", label: t("未安装 lark-cli", "lark-cli missing") }
        : larkReadyCount > 0
          ? lark.error
            ? { color: "warning", label: t("同步异常", "Sync error") }
            : larkHasImPartial
              ? { color: "success", label: t("已连接 · 部分会话", "Connected · partial") }
              : larkCalendarScopeMissing
                ? { color: "success", label: t("IM 正常 · 日历缺权限", "IM OK · calendar scope") }
                : {
                    color: "success",
                    label: larkReadyCount > 1
                      ? t(`已连接 · ${larkReadyCount} 个组织`, `Connected · ${larkReadyCount} orgs`)
                      : t("已连接", "Connected"),
                  }
          : { color: "warning", label: t("待登录授权", "Sign in required") }
    : null;

  const fdaAlertTitle = localNeedsFda && remoteFdaNames.length > 0
    ? t(`本机与「${remoteFdaNames.join("、")}」需在系统设置中开启「完全磁盘访问权限」`, `Enable Full Disk Access on this Mac and ${remoteFdaNames.join(", ")}`)
    : localNeedsFda
      ? t("需要在系统设置中为 Kulo 开启「完全磁盘访问权限」", "Enable Full Disk Access for Kulo in System Settings")
      : t(`请在「${remoteFdaNames.join("、")}」上开启「完全磁盘访问权限」`, `Enable Full Disk Access on ${remoteFdaNames.join(", ")}`);
  const sparkIssueDescription = spark?.enabled && !spark.available
    ? redactSensitiveText(
        spark.error ||
          t(
            "未检测到 Spark CLI，请在 Spark Desktop「设置 → AI Agents → Setup CLI」中启用。",
            "Spark CLI was not found. Enable it in Spark Desktop under Settings → AI Agents → Setup CLI.",
          ),
      )
    : null;
  const larkProfileError = lark?.profiles.find((profile) => !profile.ready && profile.error)?.error;
  const larkIssue = lark?.enabled
    ? !lark.cliAvailable
      ? {
          title: t("未检测到 lark-cli", "lark-cli not found"),
          description: redactSensitiveText(
            lark.error ||
              t(
                "未检测到 lark-cli，请先在主机上安装并登录飞书 CLI。",
                "lark-cli was not found. Install and sign in to lark-cli on the host.",
              ),
          ),
        }
      : larkReadyCount === 0
        ? {
            title: t("飞书待登录授权", "Lark sign-in required"),
            description: redactSensitiveText(
              lark.error ||
                larkProfileError ||
                t(
                  "尚未完成飞书登录授权，请在主机终端运行 lark-cli auth login 后重新检测。",
                  "Lark is not signed in yet. Run lark-cli auth login on the host, then re-check.",
                ),
            ),
          }
        : lark.error
          ? {
              title: t("飞书同步异常", "Lark sync error"),
              description: redactSensitiveText(lark.error),
            }
          : null
    : null;

  return (
    <SettingsSection title={t("实时感知", "Ambient awareness")}>
      <SettingsList label={t("实时感知设置", "Ambient awareness settings")}>
        <Switch
          className="w-full"
          aria-label={t("启用 macOS 通知中心感知", "Enable macOS Notification Center awareness")}
          isSelected={assistant.enabled}
          isDisabled={!connected || busyNotif}
          onChange={(enabled) => void toggleNotifications(enabled)}
        >
          <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Label className="text-sm font-normal text-foreground">{t("macOS 通知中心", "macOS Notification Center")}</Label>
              <Chip size="sm" variant="soft" color={notifStatus.color}>{notifStatus.label}</Chip>
              {busyNotif && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
            </div>
            <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
          </Switch.Content>
        </Switch>
        {spark && sparkStatus && (
          <Switch
            className="w-full"
            aria-label={t("启用 Spark Mail 深度连接", "Enable Spark Mail integration")}
            isSelected={spark.enabled}
            isDisabled={!connected || busySpark}
            onChange={(enabled) => void toggleSpark(enabled)}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Label className="text-sm font-normal text-foreground">Spark Mail</Label>
                <Chip size="sm" variant="soft" color={sparkStatus.color}>{sparkStatus.label}</Chip>
                {busySpark && !recheckingSpark && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {ha && haStatus && (
          <div className="kulo-settings-list-row justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-normal text-foreground">{t("米家 / Home Assistant", "Mi Home / Home Assistant")}</span>
              <Chip size="sm" variant="soft" color={haStatus.color}>{haStatus.label}</Chip>
            </div>
            {onOpenHomeAssistant && (
              <Button
                size="sm"
                variant="secondary"
                aria-label={ha.connected ? t("管理米家 / Home Assistant", "Manage Mi Home / Home Assistant") : t("连接米家 / Home Assistant", "Configure Mi Home / Home Assistant")}
                isDisabled={!connected}
                onPress={onOpenHomeAssistant}
              >
                {ha.connected ? t("管理", "Manage") : t("连接", "Connect")}
              </Button>
            )}
          </div>
        )}
        {lark && larkStatus && (
          <Switch
            className="w-full"
            aria-label={t("启用飞书双组织桥接", "Enable Feishu/Lark bridge")}
            isSelected={lark.enabled}
            isDisabled={!connected || busyLark}
            onChange={(enabled) => void toggleLark(enabled)}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Label className="text-sm font-normal text-foreground">{t("飞书 (lark-cli)", "Lark (lark-cli)")}</Label>
                <Chip size="sm" variant="soft" color={larkStatus.color}>{larkStatus.label}</Chip>
                {busyLark && !recheckingLark && <Spinner size="sm" aria-label={t("正在保存", "Saving")} />}
              </div>
              <Switch.Control className="justify-self-end"><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {assistant.mutedApps.length > 0 && (
          <div className="kulo-settings-list-row justify-between">
            <span className="shrink-0 text-sm font-normal text-foreground">{t("已屏蔽应用", "Muted apps")}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              {assistant.mutedApps.map((appId) => (
                <Button
                  key={appId}
                  size="sm"
                  variant="ghost"
                  aria-label={t(`取消屏蔽 ${appId}`, `Unmute ${appId}`)}
                  isDisabled={!connected || unmutingApp === appId}
                  onPress={() => void unmuteApp(appId)}
                >
                  {shortMutedAppLabel(appId)}
                  <KuloIcon name="close" size={14} />
                </Button>
              ))}
            </div>
          </div>
        )}
      </SettingsList>
      {sectionError && (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content className="min-w-0"><Alert.Description className="break-words">{sectionError}</Alert.Description></Alert.Content>
        </Alert>
      )}
      {assistant.enabled && fdaSources.length > 0 && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0"><Alert.Title>{fdaAlertTitle}</Alert.Title></Alert.Content>
          {localNeedsFda && assistant.localHost && (
            <Button className="shrink-0" size="sm" variant="secondary" isDisabled={!connected || openingSettings} isPending={openingSettings} onPress={() => void openFdaSettings()}>
              {t("打开系统设置", "Open System Settings")}
            </Button>
          )}
        </Alert>
      )}
      {assistant.enabled && !fdaSources.length && errorSource && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Description className="break-words">{redactSensitiveText(errorSource.error || t("无法读取系统通知数据库", "Unable to read the system notification database"))}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {sparkIssueDescription && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("Spark Mail 未就绪", "Spark Mail not ready")}</Alert.Title>
            <Alert.Description className="break-words">{sparkIssueDescription}</Alert.Description>
          </Alert.Content>
          <Button
            className="shrink-0"
            size="sm"
            variant="secondary"
            aria-label={t("重新检测 Spark Mail", "Re-check Spark Mail")}
            isDisabled={!connected || busySpark}
            isPending={recheckingSpark}
            onPress={() => void recheckSpark()}
          >
            {t("重新检测", "Re-check")}
          </Button>
        </Alert>
      )}
      {ha?.enabled && !ha.connected && ha.error && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("米家 / Home Assistant 连接异常", "Mi Home / Home Assistant error")}</Alert.Title>
            <Alert.Description className="break-words">{redactSensitiveText(ha.error)}</Alert.Description>
          </Alert.Content>
          {onOpenHomeAssistant && (
            <Button
              className="shrink-0"
              size="sm"
              variant="secondary"
              aria-label={t("检查米家 / Home Assistant 配置", "Check Mi Home / Home Assistant settings")}
              isDisabled={!connected}
              onPress={onOpenHomeAssistant}
            >
              {t("检查配置", "Configure")}
            </Button>
          )}
        </Alert>
      )}
      {larkIssue && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{larkIssue.title}</Alert.Title>
            <Alert.Description className="break-words">{larkIssue.description}</Alert.Description>
          </Alert.Content>
          <Button
            className="shrink-0"
            size="sm"
            variant="secondary"
            aria-label={t("重新检测飞书连接", "Re-check Lark connection")}
            isDisabled={!connected || busyLark}
            isPending={recheckingLark}
            onPress={() => void recheckLark()}
          >
            {t("重新检测", "Re-check")}
          </Button>
        </Alert>
      )}
    </SettingsSection>
  );
}
