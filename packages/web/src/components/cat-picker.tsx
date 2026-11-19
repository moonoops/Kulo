import { useState, type ReactNode } from "react";
import { Alert, Button, Popover } from "@heroui/react";
import { useI18n } from "../kulo-i18n";
import { CatAvatar } from "./cat-avatar";
import { CAT_APPEARANCES, type CatAppearanceId } from "./cat-catalog";
import { saveCatPreferences, useCatPreferences } from "./cat-preferences";
import "./cat-picker.css";

export function CatPicker({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const preferences = useCatPreferences();
  const [open, setOpen] = useState(false);
  const choose = (appearance: CatAppearanceId) => {
    if (saveCatPreferences({ appearance })) setOpen(false);
  };

  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button isIconOnly variant="ghost" className="kulo-cat-picker-trigger" aria-label={t("更换 Kulo 形象", "Change Kulo appearance")}>
      {children}
    </Button>
    <Popover.Content placement="bottom start" className="kulo-cat-picker-popover">
      <Popover.Dialog className="kulo-cat-picker-dialog" aria-label={t("Kulo 形象", "Kulo appearance")}>
        {preferences.error && <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Description>{preferences.error === "read"
            ? t("无法读取形象偏好，请检查浏览器存储权限。", "Cannot read appearance preferences. Check browser storage permissions.")
            : t("无法保存形象偏好，请检查浏览器存储权限。", "Cannot save appearance preferences. Check browser storage permissions.")}</Alert.Description></Alert.Content>
        </Alert>}
        <div className="kulo-cat-picker-gallery scrollbar" role="group" aria-label={t("选择形象", "Choose appearance")}>
          {CAT_APPEARANCES.map((appearance) => {
            const label = t(appearance.labelZh, appearance.labelEn);
            const selected = preferences.appearance === appearance.id;
            return <Button key={appearance.id} size="sm" variant={selected ? "secondary" : "ghost"}
              className="kulo-cat-picker-choice" aria-label={label} aria-pressed={selected}
              autoFocus={selected || preferences.appearance === "auto" && appearance.id === "sunglasses"}
              onPress={() => choose(appearance.id)}>
              <CatAvatar appearance={appearance.id} animated={false} className="kulo-cat-picker-thumbnail" />
            </Button>;
          })}
        </div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
