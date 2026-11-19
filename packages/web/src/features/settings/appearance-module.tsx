import { Button, Label, ListBox, Radio, RadioGroup, Select, Switch } from "@heroui/react";
import { isCatAppearance } from "../../components/cat-catalog";
import { saveCatPreferences, useCatPreferences } from "../../components/cat-preferences";
import { CHAT_FONT_SIZE_OPTIONS, useKuloAppearance, type KuloModePreference } from "../../kulo-appearance";
import { LANGUAGE_OPTIONS, useI18n, type KuloLanguage } from "../../kulo-i18n";
import { SettingsList, SettingsSection } from "./settings-layout";

const APPEARANCE_PREVIEWS = {
  light: new URL("../../assets/kulo-appearance-light.png", import.meta.url).href,
  dark: new URL("../../assets/kulo-appearance-dark.png", import.meta.url).href,
};

export function AppearanceModule() {
  const { mode, sysDark, setMode, chatFontSize, setChatFontSize, customization, resetCustomization, appearanceError } = useKuloAppearance();
  const { language, setLanguage, t } = useI18n();
  const catPreferences = useCatPreferences();
  const setAutomaticAppearance = (automatic: boolean) => {
    if (automatic) { saveCatPreferences({ appearance: "auto" }); return; }
    if (catPreferences.appearance !== "auto") { saveCatPreferences({ appearance: catPreferences.appearance }); return; }
    // Pin the visible activity outfit before leaving automatic mode.
    const displayed = typeof document === "undefined" ? null
      : document.querySelector(".kulo-agent-profile-avatar[data-appearance]")?.getAttribute("data-appearance");
    saveCatPreferences({ appearance: isCatAppearance(displayed) && displayed !== "auto" ? displayed : "sunglasses" });
  };
  const fontLabels = [t("小", "Small"), t("中", "Medium"), t("大", "Large"), t("超大", "Extra large")];
  const options: ReadonlyArray<{ value: KuloModePreference; label: string }> = [
    { value: "system", label: t("跟随系统", "System") },
    { value: "light", label: t("浅色", "Light") },
    { value: "dark", label: t("深色", "Dark") },
  ];
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
          onChange={(value) => { if (value !== null) setLanguage(value as KuloLanguage); }}
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
