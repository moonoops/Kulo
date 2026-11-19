import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { HUB_TEST_ADMIN_TOKEN } from "./hub-auth.js";
import { openTestHub } from "./secure-hub.js";

const [stateDir, boundary, requestId, ...assetIds] = process.argv.slice(2);
if (!stateDir || !requestId || !["before", "after"].includes(boundary ?? "") || assetIds.length !== 2) throw new Error("Invalid crash fixture");
const storage = await openNodeSqliteStorage(path.join(stateDir, "moco.sqlite"));
const commit = storage.commit.bind(storage);
storage.commit = async (batches, receive, context) => {
  if (batches.some(batch => batch.some(write => write.type === "submission" && write.value.requestId === requestId))) {
    if (boundary === "after") await commit(batches, receive, context);
    process.kill(process.pid, "SIGKILL");
    return new Promise<never>(() => {});
  }
  return commit(batches, receive, context);
};
const provider = fauxProvider({ provider: "openai", models: [{ id: "delivery-model" }] });
provider.setResponses([() => fauxAssistantMessage("收到")]);
const models = createModels(); models.setProvider(provider.provider);
const hub = await openTestHub({ storage, models, config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"),
  authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
  model: { defaultProvider: "openai", defaultModel: "delivery-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
} });
const attachments = assetIds.map(id => hub.uploads.toChatAttachment(hub.uploads.getUpload(id)!.record));
await hub.deliverClientMessage({ type: "chat.send", topicId: "root", requestId, content: "crash test", attachments }, "sender");
throw new Error("The expected storage commit did not occur");
