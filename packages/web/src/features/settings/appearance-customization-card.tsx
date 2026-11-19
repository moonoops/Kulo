import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Alert, Button, Card } from "@heroui/react";
import {
  appearanceCustomizationVariables, appearanceFontStack, validateAppearanceCustomization, validateAppearanceFontFamily,
  type AppearanceCustomization, type AppearanceFontRole,
} from "@moco/protocol";
import {
  getAppearanceCustomization, previewAppearanceCustomization, saveAppearanceCustomizationProposal,
} from "../../moco-appearance";
import { useI18n } from "../../moco-i18n";

export interface AppearanceCustomizationCardProps {
  proposal: AppearanceCustomization;
  expectedCurrent?: AppearanceCustomization | null;
  disabled?: boolean;
  historical?: boolean;
  applied?: boolean;
  onApply: (proposal: AppearanceCustomization) => Promise<boolean | void>;
  onCancel?: () => Promise<boolean | void>;
  onUndo?: () => Promise<boolean | void>;
}

export type AppearanceFontAvailability = "built-in" | "available" | "fallback" | "unknown";
const GENERIC_FONTS = new Set(["system-ui", "sans-serif", "serif", "monospace", "ui-sans-serif", "ui-serif", "ui-monospace"]);

/** FontFaceSet.check alone may succeed for a missing family via fallback. */
export function detectAppearanceFont(family: string, doc: Document = document): AppearanceFontAvailability {
  const clean = validateAppearanceFontFamily(family);
  if (GENERIC_FONTS.has(clean)) return "built-in";
  if (!doc.fonts || typeof doc.fonts.check !== "function") return "unknown";
  const name = JSON.stringify(clean);
  if (!doc.fonts.check(`14px ${name}`, "中文 Aa 123")) return "fallback";
  const context = doc.createElement("canvas").getContext("2d");
  if (!context) return "unknown";
  for (const fallback of ["monospace", "serif", "sans-serif"]) {
    context.font = `14px ${fallback}`;
    const baseline = context.measureText("Moco 中文阅读 AaBb 0123456789").width;
    context.font = `14px ${name}, ${fallback}`;
    if (Math.abs(context.measureText("Moco 中文阅读 AaBb 0123456789").width - baseline) > .1) return "available";
  }
  return "fallback";
}

const same = (first: AppearanceCustomization | null, second: AppearanceCustomization | null) => JSON.stringify(first) === JSON.stringify(second);

export function AppearanceCustomizationCard(props: AppearanceCustomizationCardProps) {
  const { t } = useI18n();
  const checked = useMemo(() => {
    try { return { value: validateAppearanceCustomization(props.proposal) }; }
    catch (cause) { return { error: cause instanceof Error ? cause.message : t("外观方案无效。", "Invalid appearance proposal.") }; }
  }, [props.proposal, t]);
  if (!checked.value) return <Alert status="danger"><Alert.Content role="alert">{checked.error}</Alert.Content></Alert>;
  return <ValidAppearanceCustomizationCard {...props} proposal={checked.value} />;
}

function ValidAppearanceCustomizationCard({ proposal, expectedCurrent, disabled = false, historical = false, applied = false, onApply, onCancel, onUndo }: AppearanceCustomizationCardProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedLocally, setSavedLocally] = useState(() => same(getAppearanceCustomization(), proposal));
  const [acknowledged, setAcknowledged] = useState(false);
  const [fonts, setFonts] = useState<Partial<Record<AppearanceFontRole, AppearanceFontAvailability>>>({});
  const original = useRef(expectedCurrent === undefined ? getAppearanceCustomization() : expectedCurrent);
  const signature = JSON.stringify(proposal);
  const completed = !historical && (applied || acknowledged);
  const blocked = disabled || pending || historical;

  useEffect(() => {
    if (!previewing || completed || historical || disabled) return;
    return previewAppearanceCustomization(proposal, mode);
  }, [previewing, mode, signature, completed, historical, disabled]);

  useEffect(() => {
    const detected: Partial<Record<AppearanceFontRole, AppearanceFontAvailability>> = {};
    for (const role of ["ui", "chat", "code"] as const) {
      try { detected[role] = detectAppearanceFont(proposal.fonts[role]); }
      catch { detected[role] = "unknown"; }
    }
    setFonts(detected);
  }, [signature]);

  const apply = async () => {
    setPending(true); setError(null);
    try {
      const expected = expectedCurrent === undefined ? original.current : expectedCurrent;
      saveAppearanceCustomizationProposal(proposal, expected);
      setSavedLocally(true);
      setPreviewing(false);
      if (await onApply(proposal) === false) throw new Error(t("外观已保存在本窗口，回执尚未确认，请重试确认。", "Appearance is saved in this window. Retry to confirm its receipt."));
      setAcknowledged(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("应用外观失败。", "Could not apply appearance.")); }
    finally { setPending(false); }
  };

  const cancel = async () => {
    setPreviewing(false); setPending(true); setError(null);
    try { if (await onCancel?.() === false) throw new Error(t("未能取消，请重试。", "Could not cancel. Try again.")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("取消失败。", "Could not cancel.")); }
    finally { setPending(false); }
  };

  const undo = async () => {
    setPending(true); setError(null);
    try { if (await onUndo?.() === false) throw new Error(t("未能恢复，请重试。", "Could not restore. Try again.")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("恢复失败。", "Could not restore.")); }
    finally { setPending(false); }
  };

  const status = (role: AppearanceFontRole) => fonts[role] === "built-in" ? t("浏览器内置", "Browser default")
    : fonts[role] === "available" ? t("可用", "Available")
    : fonts[role] === "fallback" ? t("未检测到，使用后备字体", "Not detected; using fallback") : t("尚未确认可用性", "Availability unconfirmed");

  return <Card variant="secondary" className="moco-appearance-customization-card" aria-label={proposal.name}>
    <Card.Header className="gap-2">
      <Card.Title className="text-sm font-medium">{proposal.name}</Card.Title>
      <div className="flex flex-wrap gap-2" aria-label={t("预览明暗模式", "Preview color mode")}>
        <Button size="sm" variant={mode === "light" ? "secondary" : "ghost"} aria-pressed={mode === "light"} onPress={() => setMode("light")}>{t("浅色", "Light")}</Button>
        <Button size="sm" variant={mode === "dark" ? "secondary" : "ghost"} aria-pressed={mode === "dark"} onPress={() => setMode("dark")}>{t("深色", "Dark")}</Button>
      </div>
    </Card.Header>
    <Card.Content className="flex min-w-0 flex-col gap-3">
      <div className={`moco-appearance-customization-preview text-sm ${mode}`} data-theme={mode} style={appearanceCustomizationVariables(proposal, mode) as CSSProperties} aria-label={t("外观预览", "Appearance preview")}>
        <span className="font-medium">Moco</span>
        <div className="moco-appearance-customization-preview__chat">{t("今天想一起做点什么？", "What shall we work on today?")}<br />中文阅读 · English text · 0123456789</div>
        <pre className="moco-appearance-customization-preview__code text-xs">const idea = "Hello, Moco";</pre>
        <div className="moco-appearance-customization-preview__input">{t("描述你的想法，提出你的问题···", "Describe your ideas, ask your questions…")}</div>
        <span className="moco-appearance-customization-preview__accent">{t("发送", "Send")}</span>
      </div>
      <dl className="flex min-w-0 flex-col gap-2 text-xs">
        {(["ui", "chat", "code"] as const).map((role) => <div key={role} className="flex min-w-0 flex-wrap justify-between gap-2">
          <dt>{role === "ui" ? t("界面字体", "Interface font") : role === "chat" ? t("对话字体", "Chat font") : t("代码字体", "Code font")}</dt>
          <dd className="min-w-0 break-words" style={{ fontFamily: appearanceFontStack(proposal.fonts[role], role) }}>{proposal.fonts[role]} · {status(role)}</dd>
        </div>)}
      </dl>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {completed && <p className="text-xs" role="status">{t("已应用", "Applied")}</p>}
      {historical && <p className="text-xs text-muted">{t("历史方案", "Historical proposal")}</p>}
    </Card.Content>
    {!historical && <Card.Footer className="moco-appearance-customization-actions">
      {completed ? onUndo && <Button size="sm" variant="ghost" isDisabled={blocked} onPress={() => void undo()}>{t("恢复原方案", "Restore previous")}</Button> : <>
        {onCancel && <Button size="sm" variant="tertiary" isDisabled={blocked || savedLocally} onPress={() => void cancel()}>{t("取消", "Cancel")}</Button>}
        <Button size="sm" variant="secondary" isDisabled={blocked || savedLocally} onPress={() => setPreviewing((value) => !value)}>{previewing ? t("退出预览", "Exit preview") : t("全局预览", "Preview in app")}</Button>
        <Button size="sm" isPending={pending} isDisabled={disabled} onPress={() => void apply()}>{savedLocally ? t("重试确认", "Retry confirmation") : t("应用", "Apply")}</Button>
      </>}
    </Card.Footer>}
  </Card>;
}
