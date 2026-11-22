import type {
  ComposioConnectSessionRequest,
  ComposioConnectedAccountView,
  ConnectionRecordView,
} from "@kulo/protocol";
import { apiRequest } from "../../kulo-api";

export const composioApi = {
  connectSession(body: ComposioConnectSessionRequest) {
    return apiRequest<{ connection: ConnectionRecordView }>("/api/connections/composio/connect-session", {
      method: "POST",
      body,
    });
  },
  listAccounts(connectionId: string, signal?: AbortSignal) {
    return apiRequest<{ accounts: ComposioConnectedAccountView[]; allowedToolkits: string[] }>(
      `/api/connections/${encodeURIComponent(connectionId)}/composio/accounts`,
      { signal },
    );
  },
  createConnectLink(connectionId: string, toolkit: string) {
    return apiRequest<{ redirectUrl: string }>(
      `/api/connections/${encodeURIComponent(connectionId)}/composio/link`,
      { method: "POST", body: { toolkit } },
    );
  },
  disconnectAccount(connectionId: string, accountId: string) {
    return apiRequest<{ ok: true }>(
      `/api/connections/${encodeURIComponent(connectionId)}/composio/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
  },
};
