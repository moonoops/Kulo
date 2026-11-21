import { useState } from "react";
import { Alert, Button, Label, ListBox, Radio, RadioGroup, Select, Spinner, Switch, toast } from "@heroui/react";
import type { KuloSettingsView } from "@kulo/protocol";
import { isCatAppearance } from "../../components/cat-catalog";
import { saveCatPreferences, useCatPreferences } from "../../components/cat-preferences";
import { CHAT_FONT_SIZE_OPTIONS, useKuloAppearance, type KuloModePreference } from "../../kulo-appearance";
import { LANGUAGE_OPTIONS, useI18n, type KuloLanguage } from "../../kulo-i18n";
import { deliverBrowserNotification } from "../notifications/browser-badge";
import { requestBrowserNotificationPermission, useNotificationPreferences } from "../notifications/notification-preferences";
import { desktopSystemPermissionBridge } from "../system-permissions/system-permissions";
import { useDesktopPreferences } from "./desktop-preferences";
import { syncPresentationLanguage } from "./language-sync";
import { SettingsList, SettingsSection } from "./settings-layout";

const APPEARANCE_PREVIEWS = {
  light: new URL("../../assets/kulo-appearance-light.png", import.meta.url).href,
  dark: new URL("../../assets/kulo-appearance-dark.png", import.meta.url).href,
};

export function AppearanceModule({
  settings,
  connected = true,
  onSettingsUpdated,
}: {
  settings?: KuloSettingsView | null;
  connected?: boolean;
  onSettingsUpdated?: (next: KuloSettingsView) => void;
} = {}) {
  const { mode, sysDark, setMode, chatFontSize, setChatFontSize, customization, resetCustomization, appearanceError } = useKuloAppearance();
  const { language, setLanguage, t } = useI18n();
  const handleLanguageChange = (next: KuloLanguage) => {
    setLanguage(next);
    if (connected && settings) {
      void syncPresentationLanguage(settings, next, onSettingsUpdated);
    }
  };
  const catPreferences = useCatPreferences();
  const desktopPreferences = useDesktopPreferences();
  const notifications = useNotificationPreferences({ desktop: desktopPreferences });
  const [testingNotification, setTestingNotification] = useState(false);
  const [notificationActionError, setNotificationActionError] = useState<string | null>(null);
  const systemPermissionBridge = desktopSystemPermissionBridge();
  const canOpenSystemNotificationSettings = Boolean(
    systemPermissionBridge && (typeof navigator === "undefined" || !navigator.platform || /mac/i.test(navigator.platform)),
  );
  const setAutomaticAppearance = (automatic: boolean) => {
    if (automatic) { saveCatPreferences({ appearance: "auto" }); return; }
    if (catPreferences.appearance !== "auto") { saveCatPreferences({ appearance: catPreferences.appearance }); return; }
    // Pin the visible activity outfit before leaving automatic mode.
    const displayed = typeof document === "undefined" ? null
      : document.querySelector(".kulo-agent-profile-avatar[data-appearance]")?.getAttribute("data-appearance");
    saveCatPreferences({ appearance: isCatAppearance(displayed) && displayed !== "auto" ? displayed : "sunglasses" });
  };

  const handleTestNotification = async () => {
    if (testingNotification) return;
    setTestingNotification(true);
    setNotificationActionError(null);
    try {
      const payload = {
        title: "Kulo",
        body: t("系统通知已就绪", "System notifications are ready"),
      };
      if (notifications.isDesktop) {
        const notify = typeof window === "undefined" ? undefined : window.kuloDesktop?.notify;
        if (!notify) {
          setNotificationActionError(t("当前客户端不支持系统通知。", "System notifications are not supported by this client."));
          return;
        }
        const delivered = await notify({ ...payload, force: true });
        if (delivered === false) {
          setNotificationActionError(t("未能发出系统通知，请检查系统通知设置。", "Could not send a system notification. Check your system notification settings."));
          return;
        }
        toast.success(t("已发送测试通知", "Test notification sent"));
        return;
      }
      const permission = await requestBrowserNotificationPermission();
      if (permission === "unsupported") {
        setNotificationActionError(t("当前浏览器不支持系统通知。", "System notifications are not supported in this browser."));
        return;
      }
      if (permission !== "granted") {
        setNotificationActionError(t("请在浏览器网站设置中允许通知权限。", "Allow notification permission in your browser site settings."));
        return;
      }
      const sent = deliverBrowserNotification(payload, { sound: notifications.preferences.sound, force: true });
      if (!sent) {
        setNotificationActionError(t("未能发出浏览器通知，请重试。", "Could not send a browser notification. Try again."));
        return;
      }
      toast.success(t("已发送测试通知", "Test notification sent"));
    } catch (cause) {
      setNotificationActionError(cause instanceof Error && cause.message
        ? cause.message
        : t("发送测试通知失败，请重试。", "Failed to send test notification. Try again."));
    } finally {
      setTestingNotification(false);
    }
  };

  const handleOpenSystemNotificationSettings = async () => {
    if (!systemPermissionBridge) return;
    setNotificationActionError(null);
    try {
      await systemPermissionBridge.openSettings("notifications");
    } catch (cause) {
      setNotificationActionError(cause instanceof Error && cause.message
        ? cause.message
        : t("无法打开系统通知设置。", "Could not open system notification settings."));
    }
  };

  const fontLabels = [t("小", "Small"), t("中", "Medium"), t("大", "Large"), t("超大", "Extra large")];
  const options: ReadonlyArray<{ value: KuloModePreference; label: string }> = [
    { value: "system", label: t("跟随系统", "System") },
    { value: "light", label: t("浅色", "Light") },
    { value: "dark", label: t("深色", "Dark") },
  ];
  const notificationControlsDisabled = notifications.loading || !notifications.ready;

  return (
    <>
      <SettingsSection title={t("明暗模式", "Theme")}>
        <RadioGroup aria-label={t("明暗模式", "Theme")} value={mode} onChange={(value) => setMode(value as KuloModePreference)}>
          <div className="kulo-appearance-options">
            {options.map((option) => {
              const previewMode = option.value === "system" ? (sysDark ? "dark" : "light") : option.value;
              return (
                <Radio key={option.value} value={option.value} className="kulo-appearance-choice">
                  <Radio.Content className="kulo-appearance-choice-content flex w-full flex-col items-stretch gap-4 p-3">
                    <img
                      src={APPEARANCE_PREVIEWS[previewMode]}
                      alt=""
                      aria-hidden="true"
                      className="aspect-[7/5] w-full rounded-lg object-cover"
                    />
                    <span className="kulo-appearance-choice-label flex items-center gap-2 px-1 pb-1 text-sm font-medium">
                      <Radio.Control><Radio.Indicator /></Radio.Control>
                      {option.label}
                    </span>
                  </Radio.Content>
                </Radio>
              );
            })}
          </div>
        </RadioGroup>
      </SettingsSection>
      <SettingsList label={t("外观偏好", "Appearance preferences")}>
        <Select variant="secondary" value={language}
          onChange={(value) => { if (value !== null) handleLanguageChange(value as KuloLanguage); }}
          className="kulo-settings-row kulo-settings-row--choice">
          <Label>{t("语言", "Language")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>
            {LANGUAGE_OPTIONS.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              <span lang={option.value}>{option.label}</span><ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox></Select.Popover>
        </Select>
        <Select variant="secondary" value={String(chatFontSize)}
          onChange={(value) => { if (value !== null) setChatFontSize(Number(value)); }}
          className="kulo-settings-row kulo-settings-row--choice">
          <Label>{t("对话字号", "Chat font size")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>
            {CHAT_FONT_SIZE_OPTIONS.map((option, index) => <ListBox.Item key={option.value} id={String(option.value)} textValue={`${fontLabels[index]} · ${option.value} px`}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                <span className="kulo-appearance-font-name">{fontLabels[index]}</span><span className="kulo-appearance-font-size text-xs text-muted tabular-nums">{option.value} px</span>
              </span><ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox></Select.Popover>
        </Select>
      </SettingsList>
      <SettingsSection title={t("Kulo 形象", "Kulo appearance")}>
        <SettingsList label={t("Kulo 形象偏好", "Kulo appearance preferences")}>
          <Switch className="w-full" aria-label={t("自动切换形象", "Automatically switch appearance")}
            isSelected={catPreferences.appearance === "auto"} onChange={setAutomaticAppearance}>
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label>{t("自动切换形象", "Automatically switch appearance")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <Switch className="w-full" aria-label={t("动态", "Animate")}
            isSelected={catPreferences.animated} onChange={(animated) => { saveCatPreferences({ animated }); }}>
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label>{t("动态", "Animate")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </SettingsList>
        {catPreferences.error && <p className="text-sm text-danger" role="alert">{catPreferences.error === "read"
          ? t("无法读取形象偏好，请检查浏览器存储权限。", "Cannot read appearance preferences. Check browser storage permissions.")
          : t("无法保存形象偏好，请检查浏览器存储权限。", "Cannot save appearance preferences. Check browser storage permissions.")}</p>}
      </SettingsSection>
      <SettingsSection
        title={t("通知", "Notifications")}
        action={
          <div className="kulo-settings-actions">
            {canOpenSystemNotificationSettings && (
              <Button size="sm" variant="tertiary" onPress={() => { void handleOpenSystemNotificationSettings(); }}>
                {t("系统通知设置", "System settings")}
              </Button>
            )}
            <Button size="sm" variant="secondary" isPending={testingNotification} onPress={() => { void handleTestNotification(); }}>
              {t("发送测试通知", "Send test notification")}
            </Button>
          </div>
        }
      >
        <SettingsList label={t("通知偏好", "Notification preferences")}>
          <Switch
            className="w-full"
            aria-label={t("系统通知", "System notifications")}
            isSelected={notifications.preferences.enabled}
            isDisabled={notificationControlsDisabled}
            isReadOnly={notifications.saving}
            onChange={(enabled) => {
              setNotificationActionError(null);
              void notifications.setEnabled(enabled);
            }}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label className="kulo-field-label">
                {t("系统通知", "System notifications")}
                {(notifications.loading || notifications.saving) && (
                  <Spinner size="sm" aria-label={notifications.loading ? t("正在读取", "Loading") : t("正在保存", "Saving")} />
                )}
              </Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <Switch
            className="w-full"
            aria-label={t("提示音", "Sound")}
            isSelected={notifications.preferences.sound}
            isDisabled={notificationControlsDisabled || !notifications.preferences.enabled}
            isReadOnly={notifications.saving}
            onChange={(sound) => {
              setNotificationActionError(null);
              void notifications.setSound(sound);
            }}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label>{t("提示音", "Sound")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
          <Switch
            className="w-full"
            aria-label={t("应用角标", "App badge")}
            isSelected={notifications.preferences.badge}
            isDisabled={notificationControlsDisabled}
            isReadOnly={notifications.saving}
            onChange={(badge) => {
              setNotificationActionError(null);
              void notifications.setBadge(badge);
            }}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label>{t("应用角标", "App badge")}</Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </SettingsList>
        {!notifications.isDesktop && notifications.preferences.enabled && notifications.browserPermission === "denied" && (
          <Alert status="warning" role="status">
            <Alert.Content>{t("浏览器已阻止通知权限，请在网站设置中重新允许。", "Notifications are blocked in your browser. Allow them in site settings.")}</Alert.Content>
          </Alert>
        )}
        {notificationActionError && (
          <Alert status="danger" role="alert">
            <Alert.Content>{notificationActionError}</Alert.Content>
          </Alert>
        )}
        {!notifications.isDesktop && notifications.error && (
          <Alert status="danger" role="alert">
            <Alert.Content>{notifications.error}</Alert.Content>
          </Alert>
        )}
      </SettingsSection>
      {desktopPreferences.supported && <SettingsSection title={t("桌面客户端", "Desktop app")}>
        <SettingsList label={t("桌面客户端偏好", "Desktop app preferences")}>
          <Switch
            className="w-full"
            aria-label={t("后台运行", "Run in background")}
            isSelected={desktopPreferences.preferences?.backgroundRunning ?? false}
            isDisabled={desktopPreferences.loading || desktopPreferences.preferences === null}
            isReadOnly={desktopPreferences.saving}
            onChange={(enabled) => { void desktopPreferences.setBackgroundRunning(enabled); }}
          >
            <Switch.Content className="kulo-settings-row kulo-settings-row--toggle">
              <Label className="kulo-field-label">
                {t("后台运行", "Run in background")}
                {(desktopPreferences.loading || desktopPreferences.saving) && (
                  <Spinner size="sm" aria-label={desktopPreferences.loading ? t("正在读取", "Loading") : t("正在保存", "Saving")} />
                )}
              </Label>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </SettingsList>
        {desktopPreferences.error && (
          <Alert status="danger" role="alert">
            <Alert.Content>{desktopPreferences.error}</Alert.Content>
            <Button size="sm" variant="tertiary" onPress={() => { void desktopPreferences.retry(); }}>
              {t("重试", "Retry")}
            </Button>
          </Alert>
        )}
      </SettingsSection>}
      {customization && <SettingsSection title={t("个人外观", "Personal appearance")} action={<Button size="sm" variant="ghost" onPress={resetCustomization}>{t("恢复默认", "Restore defaults")}</Button>}>
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p className="font-medium">{customization.name}</p>
          <p className="text-xs text-muted">{[customization.fonts.ui, customization.fonts.chat, customization.fonts.code].join(" · ")}</p>
        </div>
      </SettingsSection>}
      {appearanceError && <p className="text-sm text-danger" role="alert">{appearanceError}</p>}
    </>
  );
}
