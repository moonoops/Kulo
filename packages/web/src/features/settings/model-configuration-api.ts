import type { ModelConfigurationApi } from "@moco/protocol";
import { apiRequest } from "../../moco-api";

const path = "/api/settings/model-configuration";
export const modelConfigurationApi: ModelConfigurationApi = {
  workspace: (clientId, signal) => apiRequest(`${path}?clientId=${encodeURIComponent(clientId)}`, { signal }),
  prepare: (body) => apiRequest(`${path}/prepare`, { method: "POST", body }),
  update: (body) => apiRequest(`${path}/draft`, { method: "PUT", body }),
  credential: (body) => apiRequest(`${path}/credential`, { method: "POST", body }),
  discover: (body) => apiRequest(`${path}/discover`, { method: "POST", body }),
  test: (body, signal) => apiRequest(`${path}/test`, { method: "POST", body, signal }),
  save: (body) => apiRequest(`${path}/save`, { method: "POST", body }),
  discard: async (body) => { await apiRequest(`${path}/draft`, { method: "DELETE", body }); },
};
