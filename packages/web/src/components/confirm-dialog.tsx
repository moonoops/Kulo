import { translate as tr, useI18n } from "../moco-i18n";
import { useCallback, useRef, type ReactNode } from "react";
import { AlertDialog, Button } from "@heroui/react";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = tr("确认", "Confirm"),
  cancelLabel = tr("取消", "Cancel"),
  status = "danger",
  isPending = false,
  isConfirmDisabled = false,
  onConfirm,
  onCancel,
  onCloseComplete,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  status?: "danger" | "warning" | "accent" | "default";
  isPending?: boolean;
  isConfirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onCloseComplete?: () => void;
}) {
  useI18n();
  const latest = useRef({ open, onCloseComplete });
  latest.current = { open, onCloseComplete };
  const backdropRef = useCallback((element: HTMLDivElement | null) => {
    if (!element && !latest.current.open) latest.current.onCloseComplete?.();
  }, []);
  return (
    <AlertDialog isOpen={open} onOpenChange={(next) => !next && !isPending && onCancel()}>
      <AlertDialog.Backdrop ref={backdropRef} isOpen={open} onOpenChange={(next) => !next && !isPending && onCancel()}>
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status={status === "danger" ? "danger" : "warning"} />
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            {description && <AlertDialog.Body>{description}</AlertDialog.Body>}
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={isPending} onPress={onCancel}>
                {cancelLabel}
              </Button>
              <Button
                variant={status === "danger" ? "danger" : "primary"}
                isPending={isPending}
                isDisabled={isConfirmDisabled || isPending}
                onPress={onConfirm}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
