import { Input, Label, ListBox, NumberField, Select, Switch, TextArea, TextField } from "@heroui/react";

export function ImageSelect({ label, value, options, onChange, disabled = false, secondary = false }: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return <Select className="moco-form-field" variant={secondary ? "secondary" : "primary"} value={value || null} onChange={(next) => { if (typeof next === "string") onChange(next); }} isDisabled={disabled}>
    <Label>{label}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map((option) => <ListBox.Item key={option.id} id={option.id} textValue={option.label} isDisabled={option.disabled}>{option.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}

export function ImageText({ label, value, onChange, disabled = false, multiline = false, required = false, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "url" | "password";
}) {
  return <TextField className="moco-form-field" variant="primary" value={value} onChange={onChange} isDisabled={disabled} isRequired={required} type={type}>
    <Label>{label}</Label>
    {multiline ? <TextArea className="scrollbar min-h-28" spellCheck={false} placeholder={placeholder} /> : <Input spellCheck={false} autoComplete={type === "password" ? "new-password" : "off"} placeholder={placeholder} />}
  </TextField>;
}

export function ImageNumber({ label, value, onChange, disabled = false, minimum = 1, maximum = 100, step = 1 }: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
  minimum?: number;
  maximum?: number;
  step?: number;
}) {
  return <NumberField className="moco-form-field" variant="primary" value={value ?? NaN} onChange={(next) => onChange(Number.isFinite(next) ? next : undefined)} minValue={minimum} maxValue={maximum} step={step} isDisabled={disabled}>
    <Label>{label}</Label><NumberField.Group><NumberField.DecrementButton /><NumberField.Input /><NumberField.IncrementButton /></NumberField.Group>
  </NumberField>;
}

export function ImageToggle({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <Switch className="w-full" isSelected={value} onChange={onChange} isDisabled={disabled}><Switch.Content className="moco-form-toggle"><Label>{label}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>;
}
