import { translate as tr, useI18n } from "../../moco-i18n";
import { Children, useState } from "react";
import { defineCatalog } from "@json-render/core";
import { defineRegistry } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import {
  Button, Card, Checkbox, CheckboxGroup, Chip, Disclosure, FieldError, Input,
  Label, ListBox, NumberField, Radio, RadioGroup, Select, Slider, Switch, Tabs,
  TextArea, TextField,
} from "@heroui/react";
import { UI_COMPONENT_SCHEMAS } from "@moco/protocol";
import { DataChart, DataTable } from "./data-views";
import { displayCardValue, useCardRuntime } from "./card-runtime";

export const mocoUiCatalog = defineCatalog(schema, {
  components: {
    Card: { props: UI_COMPONENT_SCHEMAS.Card, slots: ["default"], description: "Content group" },
    Stack: { props: UI_COMPONENT_SCHEMAS.Stack, slots: ["default"], description: "Vertical content" },
    Grid: { props: UI_COMPONENT_SCHEMAS.Grid, slots: ["default"], description: "Responsive columns" },
    Text: { props: UI_COMPONENT_SCHEMAS.Text, description: "Text or a local field value" },
    Metric: { props: UI_COMPONENT_SCHEMAS.Metric, description: "A named value" },
    Chip: { props: UI_COMPONENT_SCHEMAS.Chip, description: "Short status" },
    Table: { props: UI_COMPONENT_SCHEMAS.Table, description: "Complete comparable data" },
    Choice: { props: UI_COMPONENT_SCHEMAS.Choice, description: "Single or multiple choice" },
    TextField: { props: UI_COMPONENT_SCHEMAS.TextField, description: "Text input" },
    NumberField: { props: UI_COMPONENT_SCHEMAS.NumberField, description: "Number input" },
    Select: { props: UI_COMPONENT_SCHEMAS.Select, description: "Choose an option" },
    Slider: { props: UI_COMPONENT_SCHEMAS.Slider, description: "Adjust a number" },
    Switch: { props: UI_COMPONENT_SCHEMAS.Switch, description: "Toggle a value" },
    Checkbox: { props: UI_COMPONENT_SCHEMAS.Checkbox, description: "Select a boolean" },
    Button: { props: UI_COMPONENT_SCHEMAS.Button, description: "Submit a server-issued action" },
    Tabs: { props: UI_COMPONENT_SCHEMAS.Tabs, slots: ["default"], description: "Local tab navigation" },
    Disclosure: { props: UI_COMPONENT_SCHEMAS.Disclosure, slots: ["default"], description: "Expandable details" },
    Chart: { props: UI_COMPONENT_SCHEMAS.Chart, description: "A simple chart with its data table" },
    Media: { props: UI_COMPONENT_SCHEMAS.Media, description: "An authorized asset reference" },
    Code: { props: UI_COMPONENT_SCHEMAS.Code, description: "Code content" },
  },
  actions: {},
});

export const { registry: mocoUiRegistry } = defineRegistry(mocoUiCatalog, {
  components: {
    Card: ({ props, children }) => {
      const { card } = useCardRuntime();
      const title = props.title !== card.title ? props.title : undefined;
      if (!title && !props.description) return Children.count(children) > 1
        ? <div className="moco-genui-stack">{children}</div> : <>{children}</>;
      return <Card variant="transparent" className="moco-genui-section">
        {(title || props.description) && <Card.Header className="moco-genui-section-header">
          {title && <Card.Title className="moco-genui-section-title">{title}</Card.Title>}
          {props.description && <Card.Description className="moco-genui-section-description">{props.description}</Card.Description>}
        </Card.Header>}
        <Card.Content className="moco-genui-section-content">{children}</Card.Content>
      </Card>;
    },
    Stack: ({ props, children }) => <div className="moco-genui-stack" data-gap={props.gap}>{children}</div>,
    Grid: ({ props, children }) => <div className="moco-genui-grid" data-columns={props.columns}>{children}</div>,
    Text: ({ props }) => {
      const { values } = useCardRuntime();
      return <p className="moco-genui-text" data-tone={props.tone} data-size={props.size}>
        {props.field ? displayCardValue(values[props.field]) : props.text}
      </p>;
    },
    Metric: ({ props }) => {
      const { values } = useCardRuntime();
      return <div className="moco-genui-metric"><span className="moco-genui-label">{props.label}</span>
        <span className="moco-genui-metric-value">{displayCardValue(props.field ? values[props.field] : props.value)}
          {props.unit && <span className="moco-genui-metric-unit">{props.unit}</span>}
        </span>
      </div>;
    },
    Chip: ({ props }) => <Chip size="sm" variant={props.variant} color={props.tone}><Chip.Label>{props.text}</Chip.Label></Chip>,
    Table: ({ props }) => {
      const runtime = useCardRuntime();
      const field = props.field;
      return <DataTable {...props} selection={field ? {
        mode: props.selectionMode ?? "single", value: runtime.values[field],
        onChange: (value) => runtime.change(field, value), isDisabled: runtime.locked, error: runtime.errors[field],
      } : undefined} />;
    },
    Choice: ({ props }) => {
      useI18n();
      const runtime = useCardRuntime();
      const value = runtime.values[props.field];
      const error = runtime.errors[props.field];
      if (props.multiple) return <CheckboxGroup className="moco-genui-choice" name={props.field}
        value={Array.isArray(value) ? value : []} onChange={(next) => runtime.change(props.field, next)}
        isDisabled={runtime.locked} isRequired={props.required} isInvalid={!!error} validationBehavior="aria"
        aria-label={props.label || tr("选择方案", "Choose an option")}>
        {props.label && <Label>{props.label}</Label>}
        {props.options.map((option) => <Checkbox key={option.value} value={option.value} className="moco-genui-option">
          <Checkbox.Content className="moco-genui-option-content">
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <span className="moco-genui-option-text"><span className="moco-genui-option-label">{option.label}</span>
              {option.description && <span className="moco-genui-option-description">{option.description}</span>}
            </span>
          </Checkbox.Content>
        </Checkbox>)}
        <FieldError>{error}</FieldError>
      </CheckboxGroup>;
      return <RadioGroup className="moco-genui-choice" name={props.field}
        value={typeof value === "string" ? value : ""} onChange={(next) => runtime.change(props.field, next)}
        isDisabled={runtime.locked} isRequired={props.required} isInvalid={!!error} validationBehavior="aria"
        aria-label={props.label || tr("选择方案", "Choose an option")}>
        {props.label && <Label>{props.label}</Label>}
        {props.options.map((option) => <Radio key={option.value} value={option.value} className="moco-genui-option">
          <Radio.Content className="moco-genui-option-content">
            <Radio.Control><Radio.Indicator /></Radio.Control>
            <span className="moco-genui-option-text"><span className="moco-genui-option-label">{option.label}</span>
              {option.description && <span className="moco-genui-option-description">{option.description}</span>}
            </span>
          </Radio.Content>
        </Radio>)}
        <FieldError>{error}</FieldError>
      </RadioGroup>;
    },
    TextField: ({ props }) => {
      const runtime = useCardRuntime();
      const value = runtime.values[props.field];
      return <TextField variant="secondary" className="moco-genui-field" name={props.field} value={typeof value === "string" ? value : ""}
        onChange={(next) => runtime.change(props.field, next)} isReadOnly={runtime.locked}
        isRequired={props.required} isInvalid={!!runtime.errors[props.field]} validationBehavior="aria">
        <Label>{props.label}</Label>
        {props.multiline ? <TextArea className="scrollbar" placeholder={props.placeholder} maxLength={props.maxLength} />
          : <Input placeholder={props.placeholder} maxLength={props.maxLength} />}
        <FieldError>{runtime.errors[props.field]}</FieldError>
      </TextField>;
    },
    NumberField: ({ props }) => {
      useI18n();
      const runtime = useCardRuntime();
      const value = runtime.values[props.field];
      return <NumberField variant="secondary" className="moco-genui-field" name={props.field} value={typeof value === "number" ? value : NaN}
        onChange={(next) => runtime.change(props.field, Number.isFinite(next) ? next : null)}
        minValue={props.min} maxValue={props.max} step={props.step} isDisabled={runtime.locked}
        isRequired={props.required} isInvalid={!!runtime.errors[props.field]} validationBehavior="aria">
        <Label>{props.label}</Label>
        <NumberField.Group>
          <NumberField.DecrementButton className="moco-genui-control" aria-label={tr(`减少${props.label}`, `Decrease ${props.label}`)} />
          <NumberField.Input />
          <NumberField.IncrementButton className="moco-genui-control" aria-label={tr(`增加${props.label}`, `Increase ${props.label}`)} />
        </NumberField.Group>
        <FieldError>{runtime.errors[props.field]}</FieldError>
      </NumberField>;
    },
    Select: ({ props }) => {
      const runtime = useCardRuntime();
      const value = runtime.values[props.field];
      return <Select variant="secondary" className="moco-genui-field" name={props.field} value={typeof value === "string" ? value : null}
        onChange={(next) => runtime.change(props.field, typeof next === "string" || typeof next === "number" ? String(next) : null)}
        isDisabled={runtime.locked} isRequired={props.required} isInvalid={!!runtime.errors[props.field]} validationBehavior="aria">
        <Label>{props.label}</Label>
        <Select.Trigger className="moco-genui-control"><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>{props.options.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
          {option.label}<ListBox.ItemIndicator />
        </ListBox.Item>)}</ListBox></Select.Popover>
        <FieldError>{runtime.errors[props.field]}</FieldError>
      </Select>;
    },
    Slider: ({ props }) => {
      const runtime = useCardRuntime();
      const value = runtime.values[props.field];
      return <Slider className="moco-genui-field"
        value={typeof value === "number" ? value : props.min ?? 0}
        onChange={(next) => runtime.change(props.field, Array.isArray(next) ? next[0] ?? 0 : next)}
        minValue={props.min ?? 0} maxValue={props.max ?? 100} step={props.step ?? 1} isDisabled={runtime.locked}>
        <div className="moco-genui-slider-label"><Label>{props.label}</Label><Slider.Output />{props.unit && <span>{props.unit}</span>}</div>
        <Slider.Track><Slider.Fill /><Slider.Thumb name={props.field} /></Slider.Track>
      </Slider>;
    },
    Switch: ({ props }) => {
      const runtime = useCardRuntime();
      return <Switch name={props.field} isSelected={runtime.values[props.field] === true}
        onChange={(value) => runtime.change(props.field, value)} isDisabled={runtime.locked}>
        <Switch.Content className="moco-genui-toggle-content"><Switch.Control><Switch.Thumb /></Switch.Control>{props.label}</Switch.Content>
      </Switch>;
    },
    Checkbox: ({ props }) => {
      const runtime = useCardRuntime();
      return <Checkbox name={props.field} isSelected={runtime.values[props.field] === true}
        onChange={(value) => runtime.change(props.field, value)} isDisabled={runtime.locked}>
        <Checkbox.Content className="moco-genui-toggle-content"><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{props.label}</Checkbox.Content>
      </Checkbox>;
    },
    Button: ({ props }) => {
      const runtime = useCardRuntime();
      const action = runtime.card.actions.find((item) => item.id === props.actionId);
      if (!action) return null;
      return <Button type="button" className="moco-genui-action" variant={props.variant ?? (action.kind === "cancel" ? "secondary" : "primary")}
        isDisabled={runtime.actionDisabled} isPending={runtime.pendingActionId === action.id}
        onPress={() => runtime.act(action.id)}>{props.label || action.label}</Button>;
    },
    Tabs: ({ props, children }) => {
      useI18n();
      const panels = Children.toArray(children);
      return <Tabs className="moco-genui-tabs" variant="secondary" defaultSelectedKey={props.tabs[0]?.id}>
        <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0"><Tabs.List aria-label={tr("内容分组", "Content groups")} className="w-max">{props.tabs.map((tab) => <Tabs.Tab key={tab.id} id={tab.id} className="moco-genui-control w-auto shrink-0 whitespace-nowrap">
          {tab.label}<Tabs.Indicator />
        </Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
        {props.tabs.map((tab, index) => <Tabs.Panel key={tab.id} id={tab.id}>{panels[index]}</Tabs.Panel>)}
      </Tabs>;
    },
    Disclosure: ({ props, children }) => <Disclosure defaultExpanded={props.defaultExpanded}>
      <Disclosure.Heading><Button slot="trigger" variant="ghost" size="sm" className="moco-genui-disclosure-trigger">
        <span className="moco-genui-disclosure-label">{props.title}</span><Disclosure.Indicator />
      </Button></Disclosure.Heading>
      <Disclosure.Content><Disclosure.Body>{children}</Disclosure.Body></Disclosure.Content>
    </Disclosure>,
    Chart: ({ props }) => <DataChart {...props} />,
    Media: ({ props }) => {
      useI18n();
      const runtime = useCardRuntime();
      return runtime.renderMedia?.(props) ?? <p className="moco-genui-fallback">{props.alt || tr("媒体暂不可用", "Media temporarily unavailable")}</p>;
    },
    Code: ({ props }) => {
      useI18n();
      const runtime = useCardRuntime();
      const [opened, setOpened] = useState(false);
      return <Disclosure className="moco-genui-code" onExpandedChange={(expanded) => { if (expanded) setOpened(true); }}>
        <Disclosure.Heading><Button slot="trigger" variant="ghost" size="sm" className="moco-genui-disclosure-trigger">
          <span className="moco-genui-disclosure-label">{props.fileName || tr("查看代码", "View code")}</span><Disclosure.Indicator />
        </Button></Disclosure.Heading>
        <Disclosure.Content className="moco-genui-panel"><Disclosure.Body className="moco-genui-disclosure-body">
          {opened && (runtime.renderCode?.(props) ?? <pre className="moco-genui-code-fallback"><code>{props.code}</code></pre>)}
        </Disclosure.Body></Disclosure.Content>
      </Disclosure>;
    },
  },
});
