import { translate as t, useI18n } from "../../kulo-i18n";
import { Button, Input, Label, TextField } from "@heroui/react";

export function MemoryServerList({
  addresses,
  onChange,
  disabled,
  activeEndpoint,
}: {
  addresses: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  activeEndpoint?: string;
}) {
  useI18n();
  return (
    <div className="kulo-form-stack" role="group" aria-label={t("Hindsight 地址", "Hindsight URLs")}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{t("Hindsight 地址", "Hindsight URLs")}</span>
        <Button type="button" variant="tertiary" size="sm" isDisabled={disabled || addresses.length >= 9}
          onPress={() => onChange([...addresses, ""])}>
          {t("添加备用地址", "Add backup URL")}</Button>
      </div>
      {addresses.map((address, index) => (
        <div key={index} className="kulo-field-action-row">
          <TextField isRequired type="url" value={address} isDisabled={disabled} fullWidth
            className="kulo-form-field flex-1"
            onChange={(next) => onChange(addresses.map((value, position) => position === index ? next : value))}>
            <Label className="text-muted">{index === 0 ? t("主地址", "Primary URL") : t(`备用地址 ${index}`, `Backup URL ${index}`)}</Label>
            <Input className="kulo-field-action-input" variant="secondary" placeholder="http://127.0.0.1:8888" spellCheck={false} />
          </TextField>
          {index > 0 && <Button type="button" variant="tertiary" size="sm" aria-label={t(`删除备用地址 ${index}`, `Delete backup URL ${index}`)}
              className="kulo-field-action-button"
              isDisabled={disabled}
              onPress={() => onChange(addresses.filter((_, position) => position !== index))}>
              {t("删除", "Delete")}</Button>}
        </div>
      ))}
      {activeEndpoint && <span className="break-all text-xs text-muted">{t("当前使用 ", "Current endpoint ")}{activeEndpoint}</span>}
    </div>
  );
}
