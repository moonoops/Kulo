import { translate as t, useI18n } from "../../kulo-i18n";
import { Modal } from "@heroui/react";
import type { ConnectionRecordView } from "@kulo/protocol";
import {
  ConnectionFollowupActions,
  ConnectionFollowupBody,
  useConnectionFollowup,
} from "./connection-followup";

export function SshFollowupModal({
  open,
  connection,
  connected,
  available,
  localHost,
  onChanged,
  onClose,
}: {
  open: boolean;
  connection: ConnectionRecordView;
  connected: boolean;
  available: boolean;
  localHost?: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  useI18n();
  const { state, openingSettings, permissionNotice, statusRef, check, openLocalNetworkSettings } = useConnectionFollowup({
    connection,
    connected,
    available,
    localHost,
    onChanged,
  });
  const busy = state.phase === "checking" || openingSettings;

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Modal.Backdrop isOpen={open} isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
        <Modal.Container placement="center" size="lg" scroll="inside">
          <Modal.Dialog
            aria-label={t(`连接 ${connection.name}`, `Connect ${connection.name}`)}
            className="w-full max-w-[560px] rounded-3xl"
          >
            <Modal.Header className="flex flex-row items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">{connection.name}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("关闭", "Close")} className="static" isDisabled={busy} onPress={onClose} />
            </Modal.Header>
            <Modal.Body className="kulo-form-stack">
              <ConnectionFollowupBody state={state} permissionNotice={permissionNotice} statusRef={statusRef} />
            </Modal.Body>
            <Modal.Footer className="flex-wrap justify-end gap-2">
              <ConnectionFollowupActions
                state={state}
                connected={connected}
                available={available}
                localHost={localHost}
                openingSettings={openingSettings}
                onClose={onClose}
                onCheck={(options) => void check(options)}
                onOpenLocalNetwork={() => void openLocalNetworkSettings()}
              />
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
