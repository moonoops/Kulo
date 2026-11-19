import { describe, expect, it } from "vitest";
import { inspectSensitiveText, redactSensitiveText } from "../packages/protocol/src/sensitive-text";
import { defaultRolePresets } from "../packages/protocol/src/roles";
import { composeSubagentInstructions, composeWorkerInstructions } from "../packages/hub/src/prompts";
import { CONNECTION_APPLICATIONS } from "../packages/hub/src/connection-applications";

describe("credential text admission", () => {
  it("saves Chinese account/password text and removes repeats before history", () => {
    const raw = "请记住这个账号：demo@example.test，密码：violet-123!，这是我的测试网站 https://example.test/login。密码还是 violet-123!";
    const inspected = inspectSensitiveText(raw);
    expect(inspected.saveRequested).toBe(true);
    expect(inspected.secrets).toContainEqual({ kind: "password", value: "violet-123!" });
    expect(inspected.metadata).toMatchObject({ username: "demo@example.test", url: "https://example.test/login", kind: "account" });
    expect(inspected.text).not.toContain("violet-123!");
    expect(inspected.text).toContain("密码：[已隐藏]");
  });

  it("accepts natural adjacent Chinese labels without punctuation", () => {
    const inspected = inspectSensitiveText("账号demo-user 密码violet-123! 请保存");
    expect(inspected.secrets).toEqual([{ kind: "password", value: "violet-123!" }]);
    expect(inspected.metadata.username).toBe("demo-user");
    expect(inspected.saveRequested).toBe(true);
    expect(inspected.text).toBe("账号demo-user 密码[已隐藏] 请保存");
  });

  it("keeps standard account templates when a bare website label follows the password", () => {
    const inspected = inspectSensitiveText("请记住账号：demo@example.test，密码：ingress-dummy-password-57218，网站 https://example.test/login");
    expect(inspected.customCredential).toBeUndefined();
    expect(inspected.secrets).toEqual([{ kind: "password", value: "ingress-dummy-password-57218" }]);
    expect(inspected.metadata).toMatchObject({ kind: "account", username: "demo@example.test", url: "https://example.test/login" });
  });

  it.each([
    "S3cret,with,commas",
    "two words",
    "S3cret,with,commas and spaces",
    "ends-with-}]）",
  ])("preserves an entire unquoted password tail: %s", (password) => {
    const inspected = inspectSensitiveText(`请记住账号 alice，密码是 ${password}`);
    expect(inspected.secrets).toEqual([{ kind: "password", value: password }]);
    expect(inspected.text).toBe("请记住账号 alice，密码是 [已隐藏]");
    for (const fragment of password.split(/[ ,]/u)) if (fragment) expect(inspected.text).not.toContain(fragment);
  });

  it("ends a complex unquoted password at an explicit trailing instruction", () => {
    const inspected = inspectSensitiveText("账号：alice，密码是 S3cret,with,commas and spaces，请帮我记住");
    expect(inspected.secrets).toEqual([{ kind: "password", value: "S3cret,with,commas and spaces" }]);
    expect(inspected.text).toBe("账号：alice，密码是 [已隐藏]，请帮我记住");
    expect(inspected.saveRequested).toBe(true);
  });

  it("ends complex unquoted passwords at another definite field", () => {
    const inspected = inspectSensitiveText("请保存 password=two words,with,commas, username=alice, api_key=another key value");
    expect(inspected.secrets).toEqual([
      { kind: "password", value: "two words,with,commas" },
      { kind: "apiKey", value: "another key value" },
    ]);
    expect(inspected.text).toBe("请保存 password=[已隐藏], username=alice, api_key=[已隐藏]");
  });

  it("extracts a structured SSH connection without passing its password onward", () => {
    const inspected = inspectSensitiveText("保存服务器连接，名称：测试机，ssh deploy@server.example.test -p 2222，密码：test-P@ss!word");
    expect(inspected.metadata).toMatchObject({ name: "测试机", kind: "ssh", host: "server.example.test", username: "deploy", port: 2222 });
    expect(inspected.text).not.toContain("test-P@ss!word");
  });

  it("extracts quoted JSON including escaped special characters", () => {
    const secret = 'a\\b"c ,;=&!';
    const raw = `Please save ${JSON.stringify({ username: "demo", password: secret, url: "https://example.test" })}. Again: ${secret}`;
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toContainEqual({ kind: "password", value: secret });
    expect(inspected.metadata.username).toBe("demo");
    expect(inspected.text).not.toContain(secret);
    expect(inspected.text).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(inspected.text).toContain('"password":"[已隐藏]"');
  });

  it.each(["api-key", "token", "password", "测试 api-key", "api-key "])("preserves JSON enum value %s beside an ordinary save description", (kind) => {
    const raw = JSON.stringify({ kind, category: "credential", description: "保存草稿", revision: 2 });
    expect(inspectSensitiveText(raw).secrets).toEqual([]);
    expect(redactSensitiveText(raw)).toBe(raw);
    expect(JSON.parse(redactSensitiveText(raw))).toEqual(JSON.parse(raw));
  });

  it("keeps quoted punctuation passwords private without treating JSON delimiters as secrets", () => {
    const raw = JSON.stringify({ kind: "api-key", password: ",", description: "保存草稿" });
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toEqual([{ kind: "password", value: "," }]);
    expect(inspected.text).toContain('"password":"[已隐藏]"');
    expect(JSON.parse(inspected.text)).toEqual({ kind: "api-key", password: "[已隐藏]", description: "保存草稿" });
    const natural = inspectSensitiveText('请保存 密码","');
    expect(natural.secrets).toEqual([{ kind: "password", value: "," }]);
  });

  it.each([",", "(", ")", "[", "]", "{", "}", '"', "\\", "/"])("protects JSON syntax while hiding the punctuation password %s in both passes", (secret) => {
    const raw = JSON.stringify({ password: secret, echo: secret, nested: [{ value: secret }], numbers: [1, 2] });
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toEqual([{ kind: "password", value: secret }]);
    expect(JSON.parse(inspected.text)).toEqual({ password: "[已隐藏]", echo: "[已隐藏]", nested: [{ value: "[已隐藏]" }], numbers: [1, 2] });
    expect(redactSensitiveText(raw, [secret])).toBe(inspected.text);
    expect(redactSensitiveText(inspected.text, [secret])).toBe(inspected.text);
    const knownOnly = JSON.stringify({ value: secret, embedded: `before${secret}after`, numbers: [1, 2] });
    expect(JSON.parse(redactSensitiveText(knownOnly, [secret]))).toEqual({ value: "[已隐藏]", embedded: "before[已隐藏]after", numbers: [1, 2] });
    const marked = JSON.stringify({ value: "密码：[已隐藏]" });
    expect(redactSensitiveText(marked, [secret])).toBe(marked);
    expect(redactSensitiveText(secret, [secret])).toBe("[已隐藏]");
    expect(redactSensitiveText(`before${secret}after`, [secret])).toBe(`before${secret}after`);
  });

  it("matches complete JSON punctuation escapes without damaging unrelated escapes", () => {
    expect(JSON.parse(redactSensitiveText('{"value":"\\u002c","numbers":[1,2]}', [","]))).toEqual({ value: "[已隐藏]", numbers: [1, 2] });
    expect(JSON.parse(redactSensitiveText('{"value":"\\/","numbers":[1,2]}', ["/"]))).toEqual({ value: "[已隐藏]", numbers: [1, 2] });
    const raw = JSON.stringify({ literal: "\\n", newline: "line\nnext", quoted: 'a"b' });
    expect(JSON.parse(redactSensitiveText(raw, ["\\"]))).toEqual({ literal: "[已隐藏]n", newline: "line\nnext", quoted: 'a"b' });
  });

  it("preserves the application catalog in a connection tool's JSON response", () => {
    const raw = JSON.stringify({ connections: [{ name: "测试 API", kind: "api-key", category: "credential", revision: 1 }], applications: CONNECTION_APPLICATIONS,
      requests: [{ id: "request-synthetic", connectionId: "connection-synthetic", reason: "调用测试接口", status: "pending" }] });
    expect(inspectSensitiveText(raw).secrets).toEqual([]);
    expect(redactSensitiveText(raw)).toBe(raw);
    expect(JSON.parse(redactSensitiveText(raw))).toEqual(JSON.parse(raw));
  });

  it("keeps Android observation password flags as boolean metadata in valid tool-result JSON", () => {
    const result = { version: 1, ticketId: "T-android", operationId: "android-test", runEpoch: 1,
      action: "open_app", status: "completed", data: { afterObservation: { snapshotId: "snapshot-test",
        packageName: "io.moco.fixture", nodes: [
          { nodeId: "node-one", text: "Name", password: false, editable: true },
          { nodeId: "node-two", text: "", password: true, editable: true },
        ] } } };
    const raw = JSON.stringify(result);
    expect(inspectSensitiveText(raw).secrets).toEqual([]);
    expect(redactSensitiveText(raw)).toBe(raw);
    expect(JSON.parse(redactSensitiveText(raw))).toEqual(result);
  });

  it("preserves boolean metadata while hiding actual password strings and known secret echoes", () => {
    const raw = JSON.stringify({ nodes: [{ password: false, text: "ordinary" }, { password: true, text: "known-private-echo" }],
      account: { password: "true" }, echo: "true" });
    const redacted = redactSensitiveText(raw, ["known-private-echo"]);
    expect(JSON.parse(redacted)).toEqual({ nodes: [{ password: false, text: "ordinary" }, { password: true, text: "[已隐藏]" }],
      account: { password: "[已隐藏]" }, echo: "[已隐藏]" });
    expect(redacted).not.toContain("known-private-echo");
    const onlyKnown = redactSensitiveText(JSON.stringify({ password: false, value: "false" }), ["false"]);
    expect(JSON.parse(onlyKnown)).toEqual({ password: false, value: "[已隐藏]" });
  });

  it.each([0, 123456, -123.5, 1e20])("hides a numeric JSON password %s without consuming following fields", (password) => {
    const raw = JSON.stringify({ nodes: [{ password: false }], account: { password }, after: { ok: true, count: 7 } });
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toContainEqual({ kind: "password", value: String(password) });
    expect(JSON.parse(inspected.text)).toEqual({ nodes: [{ password: false }], account: { password: "[已隐藏]" }, after: { ok: true, count: 7 } });
    expect(JSON.parse(redactSensitiveText(inspected.text, [String(password)]))).toEqual(JSON.parse(inspected.text));
  });

  it("retains redaction for password-like text inside a JSON string and plain boolean-word passwords", () => {
    const value = { password: false, text: "password=embedded-private-value", after: [1, 2] };
    expect(JSON.parse(redactSensitiveText(JSON.stringify(value)))).toEqual({ password: false, text: "password=[已隐藏]", after: [1, 2] });
    expect(redactSensitiveText("password=false")).toBe("password=[已隐藏]");
    expect(redactSensitiveText("password=true")).toBe("password=[已隐藏]");
  });

  it("hides a quoted environment variable with spaces and punctuation", () => {
    const inspected = inspectSensitiveText('export API_KEY="test secret;,!&{}[]"\nexport PASSWORD=example-pass');
    expect(inspected.secrets).toContainEqual({ kind: "apiKey", value: "test secret;,!&{}[]" });
    expect(inspected.secrets).toContainEqual({ kind: "password", value: "example-pass" });
    expect(inspected.text).toBe('export API_KEY="[已隐藏]"\nexport PASSWORD=[已隐藏]');
  });

  it("recognizes provider-prefixed environment names and camel-case JSON fields", () => {
    const inspected = inspectSensitiveText('OPENAI_API_KEY=test-provider-key\nDATABASE_PASSWORD=test-database-pass\nAWS_SECRET_ACCESS_KEY=test-aws-secret\n{"openaiApiKey":"test-json-key"}');
    for (const value of ["test-provider-key", "test-database-pass", "test-aws-secret", "test-json-key"]) {
      expect(inspected.secrets.some((secret) => secret.value === value)).toBe(true);
      expect(inspected.text).not.toContain(value);
    }
  });

  it("accepts explicit passwords which start with ordinary Chinese words", () => {
    const inspected = inspectSensitiveText("记住账号：demo，密码：安全测试123");
    expect(inspected.secrets).toContainEqual({ kind: "password", value: "安全测试123" });
    expect(inspected.text).not.toContain("安全测试123");
  });

  it.each([
    ["password=security123", "security123"],
    ["密码：如何保护", "如何保护"],
    ["密码是：如何保护", "如何保护"],
    ['密码是 "如何保护"', "如何保护"],
  ])("always redacts exact assignments and quoted values: %s", (raw, password) => {
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toContainEqual({ kind: "password", value: password });
    expect(inspected.text).not.toContain(password);
  });

  it("hides repeated literal unicode-escaped credentials as well as decoded text", () => {
    const inspected = inspectSensitiveText('保存 {"password":"p\\u0061ss-secret"}; raw echo p\\u0061ss-secret; decoded pass-secret');
    expect(inspected.secrets).toEqual([{ kind: "password", value: "pass-secret" }]);
    expect(inspected.text).not.toContain("pass-secret");
    expect(inspected.text).not.toContain("p\\u0061ss-secret");
  });

  it("handles English natural passwords", () => {
    const inspected = inspectSensitiveText("Remember my account: demo. My password is violet-123!");
    expect(inspected.secrets).toContainEqual({ kind: "password", value: "violet-123!" });
    expect(inspected.secrets.some((secret) => secret.value === "is")).toBe(false);
    expect(inspected.text).toContain("password is [已隐藏]");
  });

  it("hides bearer tokens and provider keys without a save request", () => {
    const key = "sk-proj-abcdefghijklmnopq0123456789";
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const inspected = inspectSensitiveText(`curl -H 'Authorization: Bearer ${key}' https://api.example.test\n${token}`);
    expect(inspected.text).not.toContain(key);
    expect(inspected.text).not.toContain(token);
    expect(inspected.saveRequested).toBe(false);
    expect(inspected.metadata.kind).toBe("api-key");
  });

  it.each([
    ["帮我保存 Brave 的 key: BSA-synthetic-abcdefghijklmnopqrstuvwxyz", "BSA-synthetic-abcdefghijklmnopqrstuvwxyz"],
    ["请记住 Tavily key tvly-synthetic-abcdefghijklmnopqrstuvwxyz", "tvly-synthetic-abcdefghijklmnopqrstuvwxyz"],
    ["请保存 API credential: arbitrary-complete-key", "arbitrary-complete-key"],
    ["请保存 key: custom-vendor-secret", "custom-vendor-secret"],
    ["请记住凭据：custom-credential-value", "custom-credential-value"],
  ])("stores and fully redacts an explicitly requested credential alias: %s", (raw, key) => {
    const inspected = inspectSensitiveText(raw);
    expect(inspected.secrets).toContainEqual({ kind: "apiKey", value: key });
    expect(inspected.text).not.toContain(key);
    expect(inspected.saveRequested).toBe(true);
    expect(inspected.metadata.kind).toBe("api-key");
  });

  it.each([
    "tvly-synthetic-abcdefghijklmnopqrstuvwxyz",
    "BSA-synthetic-abcdefghijklmnopqrstuvwxyz",
    "xai-synthetic-abcdefghijklmnopqrstuvwxyz",
    "pplx-synthetic-abcdefghijklmnopqrstuvwxyz",
    "hf_syntheticabcdefghijklmnopqrstuvwxyz",
    ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
  ])("redacts recognizable vendor keys without requiring save intent: %s", (key) => {
    const inspected = inspectSensitiveText(`Unexpected output: ${key}`);
    expect(inspected.text).not.toContain(key);
    expect(inspected.secrets.some((secret) => secret.value === key)).toBe(true);
    expect(inspected.saveRequested).toBe(false);
  });

  it("retains an unparseable requested credential as one encrypted custom payload", () => {
    const raw = "请保存 API key:\nopaque-credential-on-next-line";
    const inspected = inspectSensitiveText(raw);
    expect(inspected.text).toBe("[凭据已隐藏]");
    expect(inspected.text).not.toContain("opaque-credential-on-next-line");
    expect(inspected.secrets).toEqual([{ kind: "apiKey", value: raw }]);
    expect(inspected.customCredential?.fields).toEqual([{ key: "credential", label: "凭据内容", value: raw }]);
    expect(inspected.saveRequested).toBe(true);
  });

  it("keeps an unknown credential type and all arbitrary fields together", () => {
    const raw = "请保存这组「星云网关」凭据：\n凭据类型：自定义签名\n租户代号=ingress-tenant-60531\n签名种子=ingress-sign-seed-89426\n交换票据=ingress-exchange-ticket-39451";
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential).toMatchObject({ name: "星云网关", typeLabel: "自定义签名" });
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "租户代号", value: "ingress-tenant-60531" },
      { label: "签名种子", value: "ingress-sign-seed-89426" },
      { label: "交换票据", value: "ingress-exchange-ticket-39451" },
    ]);
    for (const field of inspected.customCredential!.fields) {
      expect(inspected.text).not.toContain(field.value);
      expect(inspected.secrets.some((secret) => secret.value === field.value)).toBe(true);
    }
    expect(redactSensitiveText(raw)).toBe(inspected.text);
  });

  it("preserves unknown connection strings and multiple differently named secrets", () => {
    const inspected = inspectSensitiveText("保存 生产数据库凭据：连接串=postgres://user:pw@db/test, 签名种子=somevalue, 租户码=unknownvalue");
    expect(inspected.customCredential?.name).toBe("生产数据库");
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "连接串", value: "postgres://user:pw@db/test" },
      { label: "签名种子", value: "somevalue" },
      { label: "租户码", value: "unknownvalue" },
    ]);
    expect(inspected.text).not.toContain("postgres://");
    expect(inspected.text).not.toContain("somevalue");
    expect(inspected.text).not.toContain("unknownvalue");
  });

  it("retains addresses, usernames and URLs when mixed fields select a custom card", () => {
    const inspected = inspectSensitiveText("保存数据库凭据：地址=db.example，用户名=reader，密码=long-custom-password，数据库=warehouse，url=https://db.example?opaque_ticket=unlisted-ticket");
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "地址", value: "db.example" },
      { label: "用户名", value: "reader" },
      { label: "密码", value: "long-custom-password" },
      { label: "数据库", value: "warehouse" },
      { label: "url", value: "https://db.example?opaque_ticket=unlisted-ticket" },
    ]);
    for (const value of ["db.example", "reader", "long-custom-password", "warehouse", "unlisted-ticket"]) expect(inspected.text).not.toContain(value);
  });

  it("preserves cookie fields and duplicate labels with separate safe keys", () => {
    const inspected = inspectSensitiveText("保存 NAS 会话 Cookie: SID=first-cookie-value、会话票据=nas-ticket-value、SID=second-cookie-value");
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "SID", value: "first-cookie-value" },
      { label: "会话票据", value: "nas-ticket-value" },
      { label: "SID", value: "second-cookie-value" },
    ]);
    expect(new Set(inspected.customCredential?.fields.map((field) => field.key)).size).toBe(3);
    expect(inspected.text).not.toContain("cookie-value");
    expect(inspected.text).not.toContain("nas-ticket-value");
  });

  it("preserves multiline and spaced values with arbitrary labels", () => {
    const inspected = inspectSensitiveText("请保存以下凭据：\n凭据类型=特制会话\n交换材料=first line\nsecond line with spaces\n独有标签=another spaced value");
    expect(inspected.customCredential?.typeLabel).toBe("特制会话");
    expect(inspected.customCredential?.fields.map((field) => field.value)).toEqual(["first line\nsecond line with spaces", "another spaced value"]);
  });

  it("preserves JSON nesting, escapes, arrays and repeated object keys", () => {
    const raw = '保存 测试网关凭据：{"凭据类型":"特殊签名","租户":"tenant-json-value","签名":{"材料":"first\\nsecond","材料":"second-signing-material"},"票据":["ticket-zero","ticket-one"]}';
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential?.typeLabel).toBe("特殊签名");
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "租户", value: "tenant-json-value" },
      { label: "签名.材料", value: "first\nsecond" },
      { label: "签名.材料", value: "second-signing-material" },
      { label: "票据.[0]", value: "ticket-zero" },
      { label: "票据.[1]", value: "ticket-one" },
    ]);
    for (const value of ["tenant-json-value", "first\\nsecond", "second-signing-material", "ticket-zero", "ticket-one"]) expect(inspected.text).not.toContain(value);
  });

  it("preserves JSON null and empty containers without losing source values", () => {
    const inspected = inspectSensitiveText('保存自有凭据：\n{"ticket":"opaque-fixture-23791","audience":null,"scopes":[],"options":{}}');
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "ticket", value: "opaque-fixture-23791" },
      { label: "audience", value: "null" },
      { label: "scopes", value: "[]" },
      { label: "options", value: "{}" },
    ]);
  });

  it("uses one complete opaque payload when a custom schema exceeds the card field limit", () => {
    const raw = `保存 测试凭据：\n${Array.from({ length: 33 }, (_, index) => `独有材料${index}=opaque-field-${index}`).join("\n")}`;
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential?.fields).toEqual([{ key: "credential", label: "凭据内容", value: raw }]);
    expect(inspected.text).toBe("[凭据已隐藏]");
  });

  it.each(["帮我存一下", "记录一下", "存好", "收好", "请保存以下"])("accepts ordinary save language for unknown fields: %s", (verb) => {
    const inspected = inspectSensitiveText(`${verb} 测试会话凭据：独有材料=custom-language-value`);
    expect(inspected.customCredential?.fields).toEqual([{ key: "field_1", label: "独有材料", value: "custom-language-value" }]);
    expect(inspected.saveRequested).toBe(true);
    expect(inspected.text).not.toContain("custom-language-value");
  });

  it.each([
    "这些是测试平台凭据，请记住：\n租户代号：tenant-7\n签名种子：opaque-fixture-23791",
    "这是测试平台的连接信息，帮我保存一下：\n租户代号：tenant-7\n签名种子：opaque-fixture-23791",
    "测试平台凭据我希望你能保存：\n租户代号：tenant-7\n签名种子：opaque-fixture-23791",
    "测试平台凭据，请你帮忙保存：\n租户代号：tenant-7\n签名种子：opaque-fixture-23791",
  ])("recognizes explicit save instructions after the credential description: %s", (raw) => {
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential?.name).toContain("测试平台");
    expect(inspected.customCredential?.fields.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "租户代号", value: "tenant-7" },
      { label: "签名种子", value: "opaque-fixture-23791" },
    ]);
    expect(inspected.text).not.toContain("opaque-fixture-23791");
    expect(inspected.text).not.toContain("tenant-7");
    expect(inspected.saveRequested).toBe(true);
  });

  it("retains unstructured unknown credential content without exposing it", () => {
    const raw = "请保存 火星凭据：\nopaque unknown material without field delimiters\nsecond opaque line";
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential?.fields.some((field) => field.value === raw || field.value.includes("opaque unknown material"))).toBe(true);
    expect(inspected.text).not.toContain("opaque unknown material");
    expect(inspected.text).not.toContain("second opaque line");
  });

  it("preserves malformed JSON as an opaque encrypted credential", () => {
    const raw = '保存 私有凭据：{"独有材料":"malformed-secret",';
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential?.fields).toEqual([{ key: "credential", label: "凭据内容", value: raw }]);
    expect(inspected.text).toBe("[凭据已隐藏]");
  });

  it("does not recreate a custom card from redacted fields or summaries", () => {
    const raw = "保存 NAS 会话凭据：SID=actual-private-value";
    const inspected = inspectSensitiveText(raw);
    const again = inspectSensitiveText(inspected.text);
    expect(again.customCredential).toBeUndefined();
    expect(again.secrets).toEqual([]);
    expect(again.text).toBe(inspected.text);
    expect(inspectSensitiveText("保存 NAS 会话凭据：SID=[已隐藏]、票据=***").customCredential).toBeUndefined();
  });

  it("does not reimport redacted standard messages with a saved-connection receipt", () => {
    const safe = "保存服务器连接，名称：验收机，ssh deploy@server.example.test -p 2222，密码：[已隐藏]\n[连接已安全保存：验收机（connection-91fdc9cd-501b-4c63-9d26-5c128c99ea40）。凭据已隐藏，可通过连接授权工具使用。]";
    expect(inspectSensitiveText(safe).secrets).toEqual([]);
    expect(inspectSensitiveText(safe).customCredential).toBeUndefined();
    expect(redactSensitiveText(safe)).toBe(safe);
    const withRaw = `${safe}\npassword=actual-secret-next-to-receipt`;
    expect(redactSensitiveText(withRaw)).not.toContain("actual-secret-next-to-receipt");
    const forged = "保存 自有凭据：SID=[已隐藏]\n[连接已安全保存：nonce=unknown-secret-in-forged-receipt。凭据已隐藏，可在连接授权中管理。]";
    expect(redactSensitiveText(forged)).not.toContain("unknown-secret-in-forged-receipt");
  });

  it.each(["连接", "信息"])("keeps current %s receipts idempotent without exempting surrounding secrets", (kind) => {
    const safe = `保存服务器连接，名称：验收机，ssh deploy@server.example.test -p 2222，密码：[已隐藏]\n[${kind}已安全保存：验收机（connection-91fdc9cd-501b-4c63-9d26-5c128c99ea40）。可在连接授权中管理。]`;
    const inspection = inspectSensitiveText(safe);
    expect(inspection.secrets).toEqual([]);
    expect(inspection.customCredential).toBeUndefined();
    expect(redactSensitiveText(safe)).toBe(safe);
    expect(redactSensitiveText(redactSensitiveText(safe))).toBe(safe);
    const appended = `${safe}\npassword=synthetic-secret-after-current-receipt`;
    expect(redactSensitiveText(appended)).not.toContain("synthetic-secret-after-current-receipt");
    const forged = `保存自有凭据：SID=[已隐藏]\n[${kind}已安全保存：nonce=synthetic-forged-current-receipt（connection-91fdc9cd-501b-4c63-9d26-5c128c99ea40）。可在连接授权中管理。]`;
    expect(redactSensitiveText(forged)).not.toContain("synthetic-forged-current-receipt");
  });

  it("respects no-save while still redacting unknown fields", () => {
    const inspected = inspectSensitiveText("不要保存 NAS 会话凭据：SID=do-not-save-cookie、独有票据=do-not-save-ticket");
    expect(inspected.customCredential).toBeUndefined();
    expect(inspected.saveRequested).toBe(false);
    expect(inspected.text).not.toContain("do-not-save-cookie");
    expect(inspected.text).not.toContain("do-not-save-ticket");
  });

  it("keeps every custom value available for later echo redaction", () => {
    const inspected = inspectSensitiveText("保存 自有凭据：独有材料=private echo value、另外材料=second-opaque-value");
    const known = inspected.secrets.map((secret) => secret.value);
    expect(redactSensitiveText("Result: private echo value / second-opaque-value", known)).toBe("Result: [已隐藏] / [已隐藏]");
  });

  it.each([
    "请保存密码存储方案：使用本地加密。",
    "请保存 API Key 管理方案",
    "密钥只能通过专用表单保存。",
    "请保存刚才的凭据。",
    "支持填写凭据后保存。",
    "密钥和 OAuth 验证码只能通过现有专用表单输入，不索要、不复述、不把凭证写入工具。身份文件编辑必须打开现有身份编辑器完成确认。",
    "不要加入临时情绪、一次性任务、密钥或授权扩大；不要改写身份与行事准则。",
    "请保存一条普通笔记：明天九点开会。",
    "资料已保存，Moco 可记录任意凭据。",
    "可以保存凭据资料，字段由用户填写。",
    "保存回执与凭据卡片保持一致。",
  ])("does not create custom credentials from ordinary notes or instructions: %s", (raw) => {
    const inspected = inspectSensitiveText(raw);
    expect(inspected.customCredential).toBeUndefined();
    expect(inspected.secrets).toEqual([]);
    expect(inspected.text).toBe(raw);
  });

  it.each(Object.keys(defaultRolePresets()))("does not combine unrelated save instructions and security context across a real %s agent prompt", (roleId) => {
    const roles = defaultRolePresets();
    const ticket = {
      id: "T-0001", title: "保存检查记录", goal: "检查项目并保存执行结果。", scope: "只读检查当前模块，将较长记录保存到工单草稿箱。",
      envId: "local", workspaceDir: "/tmp/moco-parser-prompt/project", scratchDir: "/tmp/moco-parser-prompt/scratch", role: roleId,
      acceptance: "报告实际运行的检查。", assignment: "不能通过文件搜索获取其他账号的 SSH 权限；凭据由主模型分配。",
    };
    const parent = composeWorkerInstructions(ticket, roles[roleId], { roles, maxSubagentsPerTicket: 4 });
    const child = composeSubagentInstructions({ parentTicket: ticket, subagentId: "agent-1", subagentName: "checker-1", rolePreset: roles[roleId], roleId, effectiveReadOnly: Boolean(roles[roleId]?.readOnly) });
    for (const prompt of [parent, child]) {
      const inspected = inspectSensitiveText(prompt);
      expect(inspected.secrets).toEqual([]);
      expect(inspected.customCredential).toBeUndefined();
      expect(inspected.text).toBe(prompt);
    }
  });

  it.each([
    '请保存这个 JavaScript 对象：{ key: "name" }',
    'Save the JSON object { "key": "display-name" }',
    'const object = { key: "user" };',
    "请保存 API Key 管理方案",
  ])("keeps ordinary object keys and credential discussion intact: %s", (raw) => {
    expect(inspectSensitiveText(raw).secrets).toEqual([]);
    expect(redactSensitiveText(raw)).toBe(raw);
  });

  it("hides URL userinfo and query credentials and keeps metadata credential-free", () => {
    const inspected = inspectSensitiveText("请保存 https://demo:p%40ss%20word@example.test/login?%61pi_key=hello%2Btoken&refresh_token=refresh%20secret#profile");
    expect(inspected.secrets).toContainEqual({ kind: "password", value: "p@ss word" });
    expect(inspected.secrets).toContainEqual({ kind: "apiKey", value: "hello+token" });
    expect(inspected.secrets).toContainEqual({ kind: "token", value: "refresh secret" });
    expect(inspected.metadata).toMatchObject({ username: "demo", url: "https://example.test/login" });
    expect(inspected.text).not.toContain("p%40ss");
    expect(inspected.text).not.toContain("hello%2Btoken");
    expect(inspected.text).not.toContain("refresh%20secret");
  });

  it("hides an SSH URL password without retaining it in server metadata", () => {
    const inspected = inspectSensitiveText("保存 ssh://deploy:unusual%40pass@server.example.test:2200/");
    expect(inspected.metadata).toEqual({ kind: "ssh", host: "server.example.test", port: 2200, username: "deploy" });
    expect(inspected.text).toContain("ssh://deploy:[已隐藏]@server.example.test:2200/");
  });

  it("normalizes IPv6 SSH and host:port metadata", () => {
    expect(inspectSensitiveText("保存 ssh://demo:long-test-pass@[2001:db8::1]:2200/").metadata).toMatchObject({ host: "2001:db8::1", port: 2200, username: "demo", kind: "ssh" });
    expect(inspectSensitiveText("保存服务器地址：server.example.test:2222，用户名：demo，密码：long-test-pass").metadata).toMatchObject({ host: "server.example.test", port: 2222, username: "demo", kind: "ssh" });
  });

  it("hides complete and unfinished multiline private keys", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nbW9jay1zZWNyZXQta2V5\n-----END OPENSSH PRIVATE KEY-----";
    const inspected = inspectSensitiveText(`保存 SSH 私钥：\n${privateKey}`);
    expect(inspected.secrets).toContainEqual({ kind: "privateKey", value: privateKey });
    expect(inspected.text).not.toContain("bW9jay1zZWNyZXQta2V5");
    expect(inspected.text).not.toContain("BEGIN OPENSSH");
    expect(redactSensitiveText("-----BEGIN PRIVATE KEY-----\nunfinished-secret")).toBe("[已隐藏]");
  });

  it("does not save credentials against an explicit instruction", () => {
    const inspected = inspectSensitiveText("不要保存，账号：demo，密码：temporary-123!");
    expect(inspected.saveRequested).toBe(false);
    expect(inspected.text).not.toContain("temporary-123!");
  });

  it.each([
    "密码怎么保存？",
    "密码是怎么保存的？",
    "密码是如何保护的？",
    "My password is stored locally.",
    "如何安全存储账号密码？",
    "密码数据库应该放在哪里？",
    "这个 API key 应该怎么管理？",
    "是否需要一个密码管理器？",
    "My password storage should be encrypted.",
    "请帮我管理账号权限。",
    "系统密钥库已锁定",
    "密钥库不可用",
    "API Key 请求头",
    "私钥口令",
    "密码已保存",
    "不要加入临时情绪、一次性任务、密钥或授权扩大；不要改写身份与行事准则。",
  ])("does not hide ordinary credential discussions: %s", (text) => {
    expect(inspectSensitiveText(text).secrets).toEqual([]);
    expect(redactSensitiveText(text)).toBe(text);
  });

  it("does not let reused secrets leak through metadata", () => {
    const inspected = inspectSensitiveText("保存 名称：test-password，账号：test-password，密码：test-password，https://example.test/test-password");
    expect(inspected.metadata.name).toBeUndefined();
    expect(inspected.metadata.username).toBeUndefined();
    expect(inspected.metadata.url).toBeUndefined();
    expect(inspected.text).not.toContain("test-password");
  });

  it("hides known secrets in plain, URI, form and JSON encoded echoes", () => {
    const secret = 's p@ss+\\"&';
    const values = [secret, encodeURIComponent(secret), encodeURIComponent(secret).replaceAll("%20", "+"), JSON.stringify(secret).slice(1, -1)];
    for (const value of values) expect(redactSensitiveText(`Echo: ${value}`, [secret])).toBe("Echo: [已隐藏]");
  });

  it("redacts short labelled passwords without corrupting ordinary words or identifiers", () => {
    const inspected = inspectSensitiveText("保存服务器：alpha.example.test，账号：alpha-user，密码：a。The password is a");
    expect(inspected.metadata).toMatchObject({ host: "alpha.example.test", username: "alpha-user", kind: "ssh" });
    expect(inspected.text).toContain("密码：[已隐藏]");
    expect(inspected.text).toContain("The password is [已隐藏]");
    expect(inspected.text).toContain("alpha.example.test");
    expect(redactSensitiveText("alpha-user and a standalone value", ["a"])).toBe("alpha-user and [已隐藏] standalone value");
  });

  it("remains idempotent on already redacted content", () => {
    const first = redactSensitiveText("账号：demo，密码：violet-123!");
    expect(redactSensitiveText(first)).toBe(first);
    expect(inspectSensitiveText(first).secrets).toEqual([]);
  });

  it("redacts very large pasted messages rather than scanning without bounds", () => {
    const inspected = inspectSensitiveText(`password=${"a".repeat(1_048_576)}`);
    expect(inspected.text).toBe("[消息过长，敏感内容已隐藏]");
    expect(inspected.secrets).toEqual([]);
  });

  it("fails closed on huge credential lists", () => {
    const inspected = inspectSensitiveText(Array.from({ length: 1_000 }, (_, index) => `password=secret-${index}`).join("\n"));
    expect(inspected.text).toBe("[敏感内容过多，请通过连接授权分别填写]");
    expect(inspected.secrets).toEqual([]);
  });

  it("does not treat English 'basic' or 'Bearer token' prose as HTTP auth credentials", () => {
    for (const text of [
      "Here is a basic configuration",
      "## Basic Recording",
      "Use a Bearer token to authenticate",
      "Bearer Authentication",
    ]) {
      expect(inspectSensitiveText(text).secrets).toEqual([]);
      expect(redactSensitiveText(text)).toBe(text);
    }
    expect(redactSensitiveText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [已隐藏]");
    expect(redactSensitiveText('{"Authorization":"Bearer short1"}')).toBe('{"Authorization":"Bearer [已隐藏]"}');
  });

  it("supports definiteOnly mode without guessing secrets from prose labels", () => {
    for (const text of [
      "命令中包含配对令牌 `example_invite_token_123456`",
      "为你生成的随机密码：K9#mP2$vL8qR4wX1",
      "moco env --token node-demo-token",
    ]) {
      expect(redactSensitiveText(text, [], { definiteOnly: true })).toBe(text);
    }
    expect(redactSensitiveText("泄露了 sk-proj-abcdefghijklmnopq0123456789", [], { definiteOnly: true })).toBe("泄露了 [已隐藏]");
    expect(redactSensitiveText("已保存口令 known-saved-secret-99", ["known-saved-secret-99"], { definiteOnly: true })).toBe("已保存口令 [已隐藏]");
  });
});
