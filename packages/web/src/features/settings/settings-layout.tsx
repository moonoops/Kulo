import { useId, useRef, useState, type ReactNode } from "react";
import { Button, Card, FieldError, Label, NumberField, Spinner } from "@heroui/react";
import { useI18n } from "../../kulo-i18n";
import { useRegisterShortcutSave } from "../shortcuts/shortcuts";

export function SettingsList({ label, children }: { label: string; children: ReactNode }) {
  return <Card className="kulo-settings-list" role="group" aria-label={label}>{children}</Card>;
}

export function SettingsSection({
  title,
  headingLevel = 2,
  status,
  action,
  children,
  className = "",
}: {
  title: string;
  headingLevel?: 2 | 3;
  status?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section className={`kulo-settings-section ${className}`} aria-labelledby={headingId}>
      <div className="kulo-settings-section-head">
        <div className="kulo-settings-section-title-group">
          <Heading id={headingId} className="kulo-section-title">{title}</Heading>
          {status}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsNumberField({
  label, ariaLabel, labelAction, value, onChange, onCommit, minValue, maxValue, step = 1,
  unit, isDisabled = false, isPending = false, isInvalid = false, errorMessage,
}: {
  label: ReactNode;
  ariaLabel?: string;
  labelAction?: ReactNode;
  value: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void | Promise<unknown>;
  minValue: number;
  maxValue: number;
  step?: number;
  unit?: ReactNode;
  isDisabled?: boolean;
  isPending?: boolean;
  isInvalid?: boolean;
  errorMessage?: string;
}) {
  const { t } = useI18n();
  const field = useRef<HTMLDivElement>(null);
  const unitId = useId();
  const latest = useRef(value);
  latest.current = value;
  const pending = useRef<Promise<unknown> | null>(null);
  const [attempted, setAttempted] = useState(false);
  const valid = Number.isFinite(value) && value >= minValue && value <= maxValue && (step % 1 !== 0 || Number.isInteger(value));
  const invalid = isInvalid || Boolean(errorMessage) || attempted && !valid;

  const commit = () => {
    if (isDisabled || isPending || pending.current) return;
    setAttempted(true);
    const next = latest.current;
    if (!Number.isFinite(next) || next < minValue || next > maxValue || step % 1 === 0 && !Number.isInteger(next)) return;
    const request = Promise.resolve(onCommit(next));
    pending.current = request;
    void request.finally(() => { if (pending.current === request) pending.current = null; });
  };

  return <NumberField ref={field} variant="secondary" className="kulo-settings-row kulo-settings-row--number" fullWidth
    aria-label={ariaLabel} aria-busy={isPending || undefined} value={value} minValue={minValue} maxValue={maxValue} step={step}
    isDisabled={isDisabled} isReadOnly={isPending} isInvalid={invalid} validationBehavior="aria"
    onChange={(next) => { latest.current = next; setAttempted(false); onChange(next); }}>
    <div className="kulo-field-label">
      <Label className="text-sm font-normal text-foreground">{label}</Label>
      {labelAction}
      {isPending && <Spinner size="sm" aria-label={t("保存中", "Saving")} />}
    </div>
    <div className="kulo-field-control kulo-field-with-unit">
      <NumberField.Group className="min-w-0">
        <NumberField.Input inputMode="numeric" aria-describedby={unit ? unitId : undefined}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && field.current?.contains(event.relatedTarget)) return;
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              commit();
            }
          }} />
      </NumberField.Group>
      {unit && <span id={unitId} className="shrink-0 text-sm text-muted">{unit}</span>}
    </div>
    {invalid && <FieldError>{errorMessage ?? t(`请输入 ${minValue} 至 ${maxValue} 的有效数值`, `Enter a valid number from ${minValue} to ${maxValue}`)}</FieldError>}
  </NumberField>;
}

export function SettingsSaveBar({
  dirty,
  busy = false,
  saving = busy,
  disabled = false,
  onDiscard,
  onSave,
  saveLabel,
  stateLabel,
  scopeLabel,
}: {
  dirty: boolean;
  busy?: boolean;
  saving?: boolean;
  disabled?: boolean;
  onDiscard: () => void;
  onSave?: () => void;
  saveLabel?: string;
  stateLabel?: string;
  scopeLabel?: string;
}) {
  const { t } = useI18n();
  const regionRef = useRef<HTMLDivElement>(null);
  useRegisterShortcutSave(regionRef, dirty && !disabled && !busy && !saving, () => {
    if (onSave) {
      onSave();
    } else {
      regionRef.current?.closest("form")?.requestSubmit();
    }
  });
  if (!dirty) return null;
  return (
    <div ref={regionRef} className="kulo-settings-savebar" role="region" aria-label={scopeLabel ?? t("未保存的更改", "Unsaved changes")} inert={busy && !saving || undefined}>
      <span className="text-sm text-muted" aria-live="polite">{stateLabel ?? t("未保存", "Unsaved")}</span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="tertiary" isDisabled={saving} onPress={onDiscard}>
          {t("放弃", "Discard")}
        </Button>
        <Button
          type={onSave ? "button" : "submit"}
          variant="primary"
          isPending={saving}
          isDisabled={disabled}
          onPress={onSave}
        >
          {saveLabel ?? t("保存", "Save")}
        </Button>
      </div>
    </div>
  );
}
