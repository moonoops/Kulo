import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Alert, Button, Input, TextField } from "@heroui/react";
import type {
  ComputerPreviewHandoffView,
  ComputerPreviewInputEvent,
  ComputerPreviewSessionView,
  TicketCardView,
  TopicSummary,
} from "@kulo/protocol";
import { useI18n } from "../../kulo-i18n";
import type { ModalFooterComposerTarget } from "../chat/modal-footer-composer";

/**
 * Maps browser client pointer coordinates onto the remote browser viewport coordinate space,
 * accurately accounting for `object-fit: contain` letterboxing around the rendered JPEG frame.
 */
export function mapImagePointerToDeviceCoords(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
  deviceWidth?: number,
  deviceHeight?: number,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const targetW = deviceWidth && deviceWidth > 0 ? deviceWidth : img.naturalWidth;
  const targetH = deviceHeight && deviceHeight > 0 ? deviceHeight : img.naturalHeight;
  if (targetW <= 0 || targetH <= 0) return null;

  const boxAspect = rect.width / rect.height;
  const imgAspect = targetW / targetH;
  let renderW = rect.width;
  let renderH = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (imgAspect > boxAspect) {
    renderH = rect.width / imgAspect;
    offsetY = (rect.height - renderH) / 2;
  } else {
    renderW = rect.height * imgAspect;
    offsetX = (rect.width - renderW) / 2;
  }
  const relX = (clientX - rect.left - offsetX) / renderW;
  const relY = (clientY - rect.top - offsetY) / renderH;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  return {
    x: Math.round(relX * targetW),
    y: Math.round(relY * targetH),
  };
}

export function keyEventModifiers(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export function mouseButtonName(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/** Freezes an immutable ModalFooterComposer target snapshot for the opened computer preview session. */
export function buildComputerPreviewTarget(
  selected: ComputerPreviewSessionView,
  options: {
    topics?: readonly TopicSummary[];
    tickets?: readonly TicketCardView[];
    fallbackTopicId?: string;
    fallbackConversationId?: number;
  } = {},
): ModalFooterComposerTarget {
  const { topics, tickets, fallbackTopicId = "root", fallbackConversationId } = options;
  if (selected.ticketId.startsWith("chat:")) {
    const seg = selected.ticketId.slice(5).split(":")[0]?.trim();
    const matchedById = seg ? topics?.find((item) => item.id === seg) : undefined;
    if (matchedById) {
      return {
        targetKind: "chat_preview",
        topicId: matchedById.id,
        ...(matchedById.conversationId !== undefined ? { conversationId: matchedById.conversationId } : {}),
        ticketId: selected.ticketId,
        previewSessionId: selected.id,
      };
    }
    if (seg && /^\d+$/.test(seg)) {
      const convId = Number(seg);
      const matchedByConv = topics?.find((item) => item.conversationId === convId);
      return {
        targetKind: "chat_preview",
        topicId: matchedByConv?.id ?? fallbackTopicId,
        conversationId: convId,
        ticketId: selected.ticketId,
        previewSessionId: selected.id,
      };
    }
    const topicId = seg || fallbackTopicId;
    const conversationId =
      topics?.find((item) => item.id === topicId)?.conversationId ??
      (topicId === fallbackTopicId ? fallbackConversationId : undefined);
    return {
      targetKind: "chat_preview",
      topicId,
      ...(conversationId !== undefined ? { conversationId } : {}),
      ticketId: selected.ticketId,
      previewSessionId: selected.id,
    };
  }

  const ticket = tickets?.find((item) => item.id === selected.ticketId);
  const topicId = ticket?.originTopicId ?? fallbackTopicId;
  const conversationId =
    topics?.find((item) => item.id === topicId)?.conversationId ??
    (topicId === fallbackTopicId ? fallbackConversationId : undefined);
  return {
    targetKind: "ticket_preview",
    topicId,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ticketId: selected.ticketId,
    previewSessionId: selected.id,
  };
}

/**
 * Tracks active remote mouse buttons, touch pointers, and pressed keys while the user interacts
 * with the live handoff viewport so focus transitions can flush release events and avoid sticky inputs.
 */
export class RemoteInputTracker {
  #heldKeys = new Map<string, { key: string; code: string; windowsVirtualKeyCode: number }>();
  #pressedMouse = new Map<"left" | "middle" | "right", { x: number; y: number }>();
  #activeTouches = new Map<number, { x: number; y: number }>();

  recordKeyDown(key: string, code: string, windowsVirtualKeyCode: number): void {
    const id = code || key;
    if (!id) return;
    this.#heldKeys.set(id, { key, code, windowsVirtualKeyCode });
  }

  recordKeyUp(key: string, code: string): void {
    const id = code || key;
    if (!id) return;
    this.#heldKeys.delete(id);
  }

  recordMouseDown(button: "left" | "middle" | "right", x: number, y: number): void {
    this.#pressedMouse.set(button, { x, y });
  }

  recordMouseMove(x: number, y: number): void {
    for (const button of this.#pressedMouse.keys()) {
      this.#pressedMouse.set(button, { x, y });
    }
  }

  recordMouseUp(button: "left" | "middle" | "right"): void {
    this.#pressedMouse.delete(button);
  }

  recordTouchStart(id: number, x: number, y: number): void {
    this.#activeTouches.set(id, { x, y });
  }

  recordTouchMove(id: number, x: number, y: number): void {
    if (this.#activeTouches.has(id)) {
      this.#activeTouches.set(id, { x, y });
    }
  }

  recordTouchEnd(id: number): void {
    this.#activeTouches.delete(id);
  }

  hasHeldInputs(): boolean {
    return this.#heldKeys.size > 0 || this.#pressedMouse.size > 0 || this.#activeTouches.size > 0;
  }

  flush(send: (event: ComputerPreviewInputEvent) => boolean): number {
    let flushed = 0;
    for (const [id, point] of this.#activeTouches) {
      send({ type: "input_touch", eventType: "touchEnd", touchPoints: [{ x: point.x, y: point.y, id }] });
      flushed++;
    }
    this.#activeTouches.clear();

    for (const [button, point] of this.#pressedMouse) {
      send({
        type: "input_mouse",
        eventType: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        clickCount: 1,
        modifiers: 0,
      });
      flushed++;
    }
    this.#pressedMouse.clear();

    for (const held of this.#heldKeys.values()) {
      send({
        type: "input_keyboard",
        eventType: "keyUp",
        key: held.key,
        code: held.code,
        windowsVirtualKeyCode: held.windowsVirtualKeyCode,
        modifiers: 0,
      });
      flushed++;
    }
    this.#heldKeys.clear();
    return flushed;
  }

  clear(): void {
    this.#heldKeys.clear();
    this.#pressedMouse.clear();
    this.#activeTouches.clear();
  }
}

export function ComputerHandoffBar({
  handoff,
  deviceName,
  onSendInput,
}: {
  handoff: ComputerPreviewHandoffView;
  deviceName: string;
  onSendInput?: (event: ComputerPreviewInputEvent) => boolean;
}) {
  const { t } = useI18n();
  const [secretText, setSecretText] = useState("");

  const sendMaskedText = () => {
    const value = secretText;
    if (!value || !onSendInput) return;
    onSendInput({ type: "input_text", text: value });
    // Clear immediately from memory so passwords/OTPs never linger in UI state
    setSecretText("");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      sendMaskedText();
    }
  };

  return (
    <div className="kulo-computer-handoff-bar">
      <Alert status="warning" className="rounded-xl p-3">
        <Alert.Indicator />
        <Alert.Content className="text-sm">
          {handoff.interactive
            ? `${handoff.reason}`
            : t(`请在「${deviceName}」桌面完成：${handoff.reason}`, `Complete on ${deviceName}: ${handoff.reason}`)}
        </Alert.Content>
      </Alert>

      {handoff.interactive && onSendInput && (
        <div className="kulo-computer-handoff-paste">
          <TextField
            variant="secondary"
            className="kulo-context-field flex-1 min-w-0"
            aria-label={t("发送验证码或密码到页面当前输入框", "Send verification code or password to focused field")}
            value={secretText}
            onChange={setSecretText}
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={t("粘贴验证码或密码并发送至页面聚焦输入框…", "Paste code or password to send to focused field…")}
              onKeyDown={handleKeyDown}
            />
          </TextField>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            isDisabled={!secretText}
            onPress={sendMaskedText}
          >
            {t("发送输入", "Send input")}
          </Button>
        </div>
      )}
    </div>
  );
}
