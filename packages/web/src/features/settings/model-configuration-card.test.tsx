import { describe, expect, it } from "vitest";
import type { ModelConfigurationDraft } from "@kulo/protocol";
import { canUseModelCredential, modelCredentialScope } from "./model-configuration-card";

const draft = (id: string, baseUrl: string) => ({ id, provider: { id: "api-test", name: "Test", api: "openai-completions", baseUrl, models: [] } } as Pick<ModelConfigurationDraft, "id" | "provider">);
describe("model configuration credential scope", () => {
  it("binds a typed credential to the draft and its URL origin before submission", () => {
    const original = draft("draft-a", "https://a.example/v1"); const scope = modelCredentialScope(original);
    expect(canUseModelCredential(scope, original)).toBe(true);
    expect(canUseModelCredential(scope, draft("draft-a", "https://a.example/v2"))).toBe(true);
    expect(canUseModelCredential(scope, draft("draft-a", "https://b.example/v1"))).toBe(false);
    expect(canUseModelCredential(scope, draft("draft-b", "https://a.example/v1"))).toBe(false);
    expect(canUseModelCredential(scope, draft("draft-a", "http://a.example/v1"))).toBe(false);
    expect(canUseModelCredential(undefined, original)).toBe(false);
  });
  it("rejects malformed and credential-bearing endpoints", () => {
    for (const url of ["", "not-a-url", "file:///tmp/config", "https://user:pass@a.example/v1"]) expect(modelCredentialScope(draft("draft-a", url))).toBeUndefined();
  });
});
