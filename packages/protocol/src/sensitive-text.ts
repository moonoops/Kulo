export type SensitiveSecretKind = "password" | "apiKey" | "privateKey" | "passphrase" | "token";

export interface CustomCredentialInspection {
  name?: string;
  typeLabel?: string;
  fields: Array<{ key: string; label: string; value: string }>;
}

export interface SensitiveTextInspection {
  text: string;
  secrets: Array<{ kind: SensitiveSecretKind; value: string }>;
  saveRequested: boolean;
  customCredential?: CustomCredentialInspection;
  metadata: {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    url?: string;
    kind?: "ssh" | "account" | "api-key";
  };
}

interface SecretSpan {
  start: number;
  end: number;
  quotedRedaction?: true;
}

interface JsonLiteralSpan extends SecretSpan { kind: "number" | "boolean" | "null" }
interface JsonTextRanges { ranges: SecretSpan[]; boundaries: Set<number>; literals: JsonLiteralSpan[]; literalAt: Map<number, JsonLiteralSpan> }

interface ParsedValue extends SecretSpan {
  value: string;
  explicit: boolean;
  assignment: boolean;
  quoted?: boolean;
}

export const SENSITIVE_TEXT_REDACTION = "[已隐藏]";
const MAX_TEXT_LENGTH = 1_048_576;
const MAX_REPLACEMENTS = 50_000;
const MAX_SECRETS_PER_TEXT = 128;
const MAX_CUSTOM_FIELDS = 32;
const SECRET_LABEL = /\b(?:[a-z][a-z0-9]*[_-])*(?:api[_ -]?key|access[_ -]?key(?:[_ -]?secret)?|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|secret[_ -]?(?:access[_ -]?)?key|client[_ -]?secret|private[_ -]?key|password|passwd|passphrase|pwd|token|secret)\b|\b[a-z][a-z0-9]*(?:Password|ApiKey|AccessToken|RefreshToken|PrivateKey|ClientSecret)\b|私钥密码|私钥口令|访问令牌|刷新令牌|访问密钥|访问秘钥|客户端密钥|客户端秘钥|API\s*密钥|API\s*秘钥|密码|口令|私钥|密钥|秘钥|令牌/giu;
const ACCOUNT_LABEL = /\b(?:user[_ -]?name|username|account|login|user)\b|登录账号|登录帐号|登录名|用户名|账号|帐号|账户|帐户/giu;
const HOST_LABEL = /\b(?:hostname|host|server|ip)\b|服务器地址|服务器|主机地址|主机|IP地址/giu;
const URL_PATTERN = /\b(?:https?|ssh|sftp|ftp):\/\/[^\s<>"'`，；。]+/giu;
const SAVE_VERB_SOURCE = "(?:记住|保存|存起来|存一下|存下|存好|收好|记录(?:一下|下来|下)?|(?:remember|store|save)\\b)";
const SAVE_REQUEST = new RegExp(SAVE_VERB_SOURCE, "iu");
const SAVE_NEGATION = /(?:不要|别|无需|不必|不需要|不想|不能)(?:.{0,8})(?:保存|记住|存|记录)|\b(?:do\s+not|don't|never|without)\s+(?:save|store|remember)\b/iu;
const ORDINARY_VALUE = /^(?:怎么|如何|怎样|是否|可以|应该|需要|不能|不可|不要|请|帮我|保存|存储|安全|管理|保护|加密|泄露|泄漏|填写|填入|输入|粘贴|放入|设置|修改|重置|忘记|是多少|是什么|不用|为空|留空|未|已|使用|通过|获取|读取|包含|数据库|库|服务|请求|策略|方案|错误|字段|相关|权限|验证|登录|认证|提示|可见|或|和|以及|及|与|等|的|只|后|用于|用来|存放|交给|提供|说明|storage\b|security\b|secure\b|how\b|should\b|can\b|please\b|save\b|store\b|stored\b|remember\b|paste\b|insert\b|management\b|manager\b|encrypted\b|redacted\b|hidden\b|here\b|goes\b|not\b|is\s+(?:safe|stored)\b)/iu;
const REQUESTED_CREDENTIAL_ALIAS = /(?<![\p{L}\p{N}_-])(?:key|credentials?|access[_ -]?code)\b|(?:凭据|凭证)(?!类型)|授权码/giu;
const STRONG_CREDENTIAL_CONTEXT = /\b(?:api|oauth|ssh|credential|password|secret|token|brave|tavily|xai|openai|anthropic|github|cloudflare|gemini|perplexity|huggingface)\b|密码|密钥|秘钥|凭据|凭证|授权码/iu;
const CODE_KEY_CONTEXT = /\b(?:javascript|typescript|json|object|record|map|dictionary|code|property|field)\b|对象|代码|字典|属性|字段|键名|键值|配置项/iu;
const GENERIC_CREDENTIAL_CONTEXT = /凭据|凭证|授权(?:信息|资料|码)|密码|密钥|秘钥|令牌|口令|登录(?:信息|资料)|会话|票据|连接(?:串|信息|资料|授权)|签名(?:种子|密钥)|\b(?:credentials?|secret|password|token|cookie|session|ticket|connection\s*string|authorization\s*(?:data|code))\b/iu;
const GENERIC_SAVE_COMMAND = new RegExp(`^(?:(?:请|帮我|替我|给我|麻烦你|请帮我|请替我|我想|我要|我需要|不要|别|无需|不必)[\\t ]*)?${SAVE_VERB_SOURCE}|^(?:(?:请|帮我|替我|给我)[\\t ]*)?把[^\\r\\n]{1,100}${SAVE_VERB_SOURCE}|^I\\s+(?:want|need)\\s+you\\s+to\\s+(?:save|store|remember)\\b|(?:^|[，,。;；\\s])(?:请|帮我|替我|给我|麻烦你|请帮我|不要|别)${SAVE_VERB_SOURCE}(?:一下|起来)?(?=[\\s:：，,]|$)|(?:请|帮我|替我|给我)(?:帮我)?${SAVE_VERB_SOURCE}(?:这些|这组|一下|它)?[。.!！\\s]*$`, "iu");
const CREDENTIAL_DISCUSSION = /(?:凭据|凭证|密码|密钥|秘钥|令牌|口令|api\s*key|credentials?|password|secret|token)[\t ]*(?:的|如何|怎么|怎样|是怎么|是如何)?[\t ]*(?:安全|存储|保存|管理|使用|storage|saving|security|management)?[\t ]*(?:方案|策略|讨论|原理|机制|规则|说明|文档|建议|plan\b|strategy\b|discussion\b|guide\b|documentation\b)/iu;
const GENERIC_FIELD = /(?:^|(?<=[\s,，;；、:：{\[]))(?:("(?:\\.|[^"\\\r\n]){1,160}")|('(?:\\.|[^'\\\r\n]){1,160}')|([\p{L}\p{N}_][\p{L}\p{N}_ .()（）-]{0,79}?))[\t ]*[:：=][\t ]*/gu;
const DECLARATIVE_SAVE = /^(?:可以保存|可保存|能保存|支持保存|用于保存|资料已保存|已保存|保存回执|保存记录|Kulo可记录)/iu;
const PUBLIC_CREDENTIAL_FIELD = /^(?:name|title|名称|连接名称|连接名|type|typelabel|credentialtype|凭据类型|凭证类型|授权类型|类型|username|user|account|login|用户名|账号|帐号|账户|帐户|登录名|host|hostname|server|服务器|服务器地址|主机|主机地址|port|端口|url|网址|网站|地址)$/iu;

interface GenericCredentialField extends SecretSpan { label: string; value: string }
interface GenericCredentialParse { fields: GenericCredentialField[]; name?: string; typeLabel?: string; fallback?: boolean }

function hasExplicitCredentialSaveRequest(text: string): boolean {
  const clauses = text.split(/[\r\n。！？!?；;]/u);
  const politeRequest = new RegExp(`(?:请|帮我|替我|给我|麻烦你|我希望|希望你|我想|我要|please)[^\\r\\n]{0,60}${SAVE_VERB_SOURCE}`, "iu");
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index]!.trim();
    if (!SAVE_REQUEST.test(clause)) continue;
    if (DECLARATIVE_SAVE.test(clause) && !politeRequest.test(clause)) continue;
    if (!GENERIC_SAVE_COMMAND.test(clause) && !politeRequest.test(clause)) continue;
    if (GENERIC_CREDENTIAL_CONTEXT.test(clause)) return true;
    // A short request can introduce a credential heading on the following line.
    if (clause.length < 60 && new RegExp(`^(?:(?:请|帮我|替我|给我|麻烦你|请帮我)[\\t ]*)?${SAVE_VERB_SOURCE}(?:以下|这些|这组|资料|内容|一下)?[\\t :：]*$`, "iu").test(clause)) {
      const next = clauses[index + 1]?.trim();
      if (next && next.length < 160 && GENERIC_CREDENTIAL_CONTEXT.test(next) && !CREDENTIAL_DISCUSSION.test(next)) return true;
    }
  }
  return false;
}

function isCredentialPlaceholder(value: string): boolean {
  return !value || /^(?:\[(?:已隐藏|凭据已隐藏|自定义凭据已隐藏|REDACTED|HIDDEN)\]|\*{3,}|•+|\.{3,}|…+|<[^>]*(?:hidden|redacted|隐藏)[^>]*>)$/iu.test(value.trim());
}

function cleanFieldLabel(label: string): string {
  return label.replace(new RegExp(`^(?:(?:请|帮我|替我|给我)[\\t ]*)?${SAVE_VERB_SOURCE}[\\t ]*`, "iu"), "").replace(/^(?:以下|这个|这组|这份|这些|我的|my\s+|the\s+|this\s+)/iu, "").trim().slice(0, 100);
}

function isKnownCredentialField(label: string): boolean {
  if (PUBLIC_CREDENTIAL_FIELD.test(normalizedLabel(label))) return true;
  SECRET_LABEL.lastIndex = 0;
  const match = SECRET_LABEL.exec(label);
  SECRET_LABEL.lastIndex = 0;
  return Boolean(match && match.index + match[0].length === label.length) || /(?:^|[\s_-])(?:key|credential|credentials|access code)$/iu.test(label);
}

function credentialHeader(text: string): Pick<GenericCredentialParse, "name" | "typeLabel"> {
  const heading = (text.split(/[\r\n:：=]/u, 1)[0] ?? "").replace(new RegExp(`[，,][\\t ]*(?:请|帮我|替我|给我|麻烦你|请帮我)?${SAVE_VERB_SOURCE}(?:一下|起来)?[\\t ]*$`, "iu"), "");
  const quoted = heading.match(/[「『“"]([^」』”"\r\n]{1,100})[」』”"]/u)?.[1];
  const name = quoted ?? cleanFieldLabel(heading).replace(/^(?:这些是|这是|是|这组|这份|这个|这些|一组|我的|the|this)[\t ]*/iu, "").replace(/(?:的)?(?:凭据|凭证|连接信息|连接资料|credentials?)[\t ]*$/iu, "").trim();
  const safeName = name && name.length <= 100 && !/^[\s]*[\[{]/u.test(name) && !/[:：=]/u.test(name) ? name : undefined;
  return { ...(safeName ? { name: safeName } : {}) };
}

function genericJsonFields(text: string, start: number): { fields: GenericCredentialField[]; end: number } | undefined {
  let position = start;
  const fields: GenericCredentialField[] = [];
  const whitespace = () => { while (position < text.length && /\s/u.test(text[position]!)) position++; };
  const string = (): { value: string; start: number; end: number } => {
    if (text[position] !== '"') throw new Error("invalid_json");
    const tokenStart = position++;
    const valueStart = position;
    while (position < text.length) {
      if (text[position] === "\\") { position += 2; continue; }
      if (text[position] === '"') {
        const end = position++;
        return { value: JSON.parse(text.slice(tokenStart, position)) as string, start: valueStart, end };
      }
      position++;
    }
    throw new Error("invalid_json");
  };
  const value = (path: string[], depth: number): void => {
    if (depth > 16 || fields.length > MAX_SECRETS_PER_TEXT) throw new Error("large_json");
    whitespace();
    const character = text[position];
    if (character === "{") {
      const tokenStart = position;
      position++;
      whitespace();
      if (text[position] === "}") { position++; fields.push({ label: path.join(".") || "凭据内容", value: "{}", start: tokenStart, end: position }); return; }
      while (position < text.length) {
        whitespace();
        const key = string().value;
        whitespace();
        if (text[position++] !== ":") throw new Error("invalid_json");
        value([...path, key], depth + 1);
        whitespace();
        const delimiter = text[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error("invalid_json");
      }
      throw new Error("invalid_json");
    }
    if (character === "[") {
      const tokenStart = position;
      position++;
      whitespace();
      if (text[position] === "]") { position++; fields.push({ label: path.join(".") || "凭据内容", value: "[]", start: tokenStart, end: position }); return; }
      let index = 0;
      while (position < text.length) {
        value([...path, `[${index++}]`], depth + 1);
        whitespace();
        const delimiter = text[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error("invalid_json");
      }
      throw new Error("invalid_json");
    }
    if (character === '"') {
      const field = string();
      fields.push({ ...field, label: path.join(".") });
      return;
    }
    const tokenStart = position;
    while (position < text.length && !/[\s,}\]]/u.test(text[position]!)) position++;
    if (position === tokenStart) throw new Error("invalid_json");
    const raw = text.slice(tokenStart, position);
    const primitive = JSON.parse(raw) as unknown;
    if (primitive === null || typeof primitive === "number" || typeof primitive === "boolean") {
      fields.push({ start: tokenStart, end: position, label: path.join("."), value: String(primitive) });
    } else throw new Error("invalid_json");
  };
  try { value([], 0); return { fields, end: position }; }
  catch { return undefined; }
}

function parseGenericCredential(text: string, knownSecrets: readonly string[]): GenericCredentialParse | undefined {
  if (/^\s*[\[{]/u.test(text) || !hasExplicitCredentialSaveRequest(text) || text.startsWith("[凭据已隐藏]")) return undefined;
  const firstHeading = text.split(/[\r\n:：=]/u, 1)[0] ?? "";
  if (CREDENTIAL_DISCUSSION.test(firstHeading) || /^(?:怎么|如何|怎样|讨论|\s*how\b)/iu.test(text.trim())) return undefined;
  const header = credentialHeader(text);
  const fields: GenericCredentialField[] = [];
  let jsonRange: SecretSpan | undefined;
  const jsonStart = text.search(/(?:^|[\r\n:：])[\t ]*\{|(?:save|store|remember|保存|记住|凭据|凭证)[\t ]*\{/iu);
  if (jsonStart >= 0) {
    const objectStart = text.indexOf("{", jsonStart);
    const parsed = genericJsonFields(text, objectStart);
    if (!parsed) return { ...header, fields: [], fallback: true };
    fields.push(...parsed.fields);
    jsonRange = { start: objectStart, end: parsed.end };
  }
  const ipv6Ranges = [...text.matchAll(/\[[0-9a-f:]+\](?::\d{1,5})?/giu)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const receiptRanges = [...text.matchAll(/\[(?:连接|信息)已安全保存：[^\[\]\r\n=:：]{1,600}（connection-[a-f0-9-]{36}）(?:，待补全连接信息)?(?:；[^\[\]\r\n=:：]{1,100}（connection-[a-f0-9-]{36}）(?:，待补全连接信息)?)*。(?:凭据已隐藏，)?可(?:通过连接授权工具使用|在连接授权中管理)。\]/giu)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const assignments = [...text.matchAll(GENERIC_FIELD)].filter((match) => {
    if (jsonRange && match.index >= jsonRange.start && match.index < jsonRange.end || [...ipv6Ranges, ...receiptRanges].some((range) => match.index >= range.start && match.index < range.end)) return false;
    const from = match.index + match[0].length;
    if (text.startsWith("//", from)) return false;
    // The second colon of `host:port` belongs to the preceding address value.
    const label = match[3]?.trim();
    if (label && /[:：]/u.test(text[match.index - 1] ?? "") && /^[a-z0-9][a-z0-9.-]*$/iu.test(label) && /^\d{1,5}(?=[\s,，;；、]|$)/u.test(text.slice(from))) return false;
    return true;
  });
  if (assignments.length > MAX_SECRETS_PER_TEXT) return { ...header, fields: [], fallback: true };
  for (let index = 0; index < assignments.length; index++) {
    const assignment = assignments[index]!;
    const label = cleanFieldLabel(assignment[1] ? decodeQuoted(assignment[1].slice(1, -1), '"') : assignment[2] ? decodeQuoted(assignment[2].slice(1, -1), "'") : assignment[3]!);
    const start = assignment.index + assignment[0].length;
    if (!label || text.startsWith("//", start)) continue;
    if (text.startsWith(SENSITIVE_TEXT_REDACTION, start)) continue;
    const next = assignments[index + 1]?.index ?? text.length;
    let end = next;
    while (end > start && /[\s,，;；、]/u.test(text[end - 1]!)) end--;
    if (end <= start || jsonRange && start <= jsonRange.start && end >= jsonRange.start) continue;
    const quoted = readValue(text, start, true);
    if (quoted?.quoted) {
      fields.push({ label, value: quoted.value, start: quoted.start, end: quoted.end });
      continue;
    }
    if (isKnownCredentialField(label) && !PUBLIC_CREDENTIAL_FIELD.test(normalizedLabel(label))) {
      const known = readSecretValue(text, start, true);
      if (known && known.end <= end) {
        fields.push({ label, value: known.value, start: known.start, end: known.end });
        continue;
      }
    }
    const raw = text.slice(start, end);
    if (isCredentialPlaceholder(raw.trim())) continue;
    if (/^[\t ]*[\[{]/u.test(raw) && !/^\[[0-9a-f:]+\](?::\d{1,5})?$/iu.test(raw.trim())) return { ...header, fields: [], fallback: true };
    // Exclude a final explicit instruction, while preserving arbitrary multiline values.
    const instruction = raw.search(/[\s,，;；、](?=(?:请|帮我|替我|给我)?(?:记住|保存|存起来)|please\s+(?:save|remember|store))/iu);
    if (instruction >= 0) end = start + instruction;
    fields.push({ label, value: text.slice(start, end).trimEnd(), start, end });
  }
  const actual = fields.filter((field) => !isCredentialPlaceholder(field.value));
  const isPublic = (field: GenericCredentialField) => !field.label.includes(".") && PUBLIC_CREDENTIAL_FIELD.test(normalizedLabel(field.label)) && !/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@|[?&](?:password|api[_-]?key|token|secret)=/iu.test(field.value);
  const knownEcho = (field: GenericCredentialField) => /^(?:again|echo|raw echo|decoded|result|再次|回显|重复|原文)$/iu.test(field.label) && knownSecrets.includes(field.value);
  const unknown = actual.filter((field) => !isPublic(field) && !isKnownCredentialField(field.label) && !knownEcho(field));
  const declaredType = actual.find((field) => /^(?:type|typelabel|credentialtype|凭据类型|凭证类型|授权类型|类型)$/iu.test(normalizedLabel(field.label)));
  const declaredName = actual.find((field) => /^(?:name|title|名称|连接名称|连接名)$/iu.test(normalizedLabel(field.label)));
  const secretFields = actual.filter((field) => !isPublic(field));
  const completeCustomFields = actual.filter((field) => !/^(?:name|title|名称|连接名称|连接名|type|typelabel|credentialtype|凭据类型|凭证类型|授权类型|类型)$/iu.test(normalizedLabel(field.label)));
  const customTypeHeader = /凭据|凭证|credentials?/iu.test(firstHeading) && header.name && !/^(?:ssh(?:服务器)?|服务器|账号|帐号|账户|帐户|api(?:\s*key)?|key|密码|密钥|连接)$/iu.test(header.name);
  if (unknown.length || declaredType && secretFields.length || customTypeHeader && secretFields.length) {
    if (completeCustomFields.length > MAX_CUSTOM_FIELDS) return { ...header, fields: [], fallback: true };
    return { ...header, ...(declaredName ? { name: declaredName.value } : {}), ...(declaredType ? { typeLabel: declaredType.value } : {}), fields: completeCustomFields };
  }
  if (!secretFields.length && actual.length) return undefined;
  if (secretFields.length) return secretFields.some((field) => !knownSecrets.includes(field.value)) ? { ...header, fields: [], fallback: true } : undefined;
  if (fields.length || /\[(?:已隐藏|凭据已隐藏|REDACTED|HIDDEN)\]|\*{3,}/iu.test(text)) return undefined;
  const clearRequest = GENERIC_SAVE_COMMAND.test(text.trim()) || new RegExp(`(?:请|帮我|替我|给我|我希望|我想|要求你|please)[^\\r\\n]{0,60}${SAVE_VERB_SOURCE}`, "iu").test(text);
  if (!clearRequest) return undefined;
  const afterNoun = text.match(/(?:凭据|凭证|cookie|session|ticket|credentials?|连接串|会话票据)[\s:：=，,；;]*(.+)$/isu)?.[1]?.trim();
  if (afterNoun && !/^[。.!！?？\s]+$/u.test(afterNoun) && !ORDINARY_VALUE.test(afterNoun) && !/^(?:刚才|上面|之前|已有|先前|那组|这些|这组|这个|这份|当前|只能|只|仅|都|应|能|可|不|需要|支持|允许|避免)/u.test(afterNoun)) return { ...header, fields: [], fallback: true };
  return undefined;
}

function opaqueCredential(text: string, saveRequested: boolean): SensitiveTextInspection {
  return {
    text: "[凭据已隐藏]",
    secrets: [{ kind: "apiKey", value: text }],
    saveRequested,
    metadata: {},
    ...(saveRequested ? { customCredential: { typeLabel: "自定义凭据", fields: [{ key: "credential", label: "凭据内容", value: text }] } } : {}),
  };
}

function sanitizedCustomCredential(parsed: GenericCredentialParse, knownSecrets: readonly string[]): CustomCredentialInspection {
  const unsafe = (value: string) => knownSecrets.some((secret) => secret && (secret.length < 4 ? value === secret : value.includes(secret) || value.length >= 8 && secret.includes(value)));
  const title = (value: string | undefined) => value && !unsafe(value) && value.length <= 100 && !/[\r\n\x00-\x1f]/u.test(value) ? value : undefined;
  return {
    ...(title(parsed.name) ? { name: title(parsed.name) } : {}),
    ...(title(parsed.typeLabel) ? { typeLabel: title(parsed.typeLabel) } : {}),
    fields: parsed.fields.map((field, index) => ({
      key: `field_${index + 1}`,
      label: title(field.label) ?? `保密字段 ${index + 1}`,
      value: field.value,
    })),
  };
}

function secretKind(label: string): SensitiveSecretKind {
  if (/private|私钥/iu.test(label)) return /password|passphrase|密码|口令/iu.test(label) ? "passphrase" : "privateKey";
  if (/passphrase/iu.test(label)) return "passphrase";
  if (/password|passwd|pwd|密码|口令/iu.test(label)) return "password";
  if (/token|令牌/iu.test(label)) return "token";
  return "apiKey";
}

function safeDecode(value: string, form = false): string {
  try { return decodeURIComponent(form ? value.replaceAll("+", " ") : value); }
  catch { return value; }
}

function decodeQuoted(value: string, quote: string): string {
  if (quote === '"') {
    try { return JSON.parse(`"${value}"`) as string; }
    catch { /* Shell double quotes can contain escapes which JSON does not accept. */ }
  }
  return value.replace(/\\([\\"'`])/g, "$1");
}

const QUOTE_ENDINGS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’" };

function closingQuotes(text: string): ReadonlySet<number> {
  const ends = new Set<number>();
  let closing: string | undefined;
  for (let position = 0; position < text.length; position++) {
    const character = text[position]!;
    if (closing) {
      if (character === "\\") position++;
      else if (character === closing) { ends.add(position); closing = undefined; }
    } else closing = QUOTE_ENDINGS[character];
  }
  return ends;
}

function readValue(text: string, from: number, allowBare: boolean, quotedEnds?: ReadonlySet<number>): ParsedValue | undefined {
  let position = from;
  while (position < text.length && /[\t ]/u.test(text[position]!)) position++;
  // A label occurring at the end of a string value (for example "api-key")
  // cannot open another value by reusing that string's closing quote.
  if (quotedEnds?.has(position) && !/^["']\s*[:=]/u.test(text.slice(position, position + 20))) return undefined;
  // A quote here closes a JSON/object field name, rather than opening its value.
  if ((text[position] === '"' || text[position] === "'") && /^['"]\s*[:=]/u.test(text.slice(position, position + 20))) position++;
  while (position < text.length && /[\t ]/u.test(text[position]!)) position++;
  let explicit = false;
  let assignment = false;
  if (text[position] === ":" || text[position] === "：" || text[position] === "=") {
    explicit = true;
    assignment = true;
    position++;
    if (text[position] === ">") position++;
  } else if (text[position] === "是" || text[position] === "为") {
    explicit = true;
    position++;
    if (text[position] === ":" || text[position] === "：") { assignment = true; position++; }
  } else if (/^is(?:\s|:)/iu.test(text.slice(position, position + 5))) {
    explicit = true;
    position += 2;
    if (text[position] === ":") { assignment = true; position++; }
  }
  while (position < text.length && /[\t ]/u.test(text[position]!)) position++;
  if (!explicit && !allowBare) return undefined;
  if (position >= text.length || /[\r\n，,；;。}\]]/u.test(text[position]!)) return undefined;
  if (text.startsWith(SENSITIVE_TEXT_REDACTION, position)) return undefined;
  const quote = text[position]!;
  const closing = QUOTE_ENDINGS[quote];
  if (closing) {
    const start = position + 1;
    position++;
    while (position < text.length) {
      if (text[position] === "\\" && position + 1 < text.length) { position += 2; continue; }
      if (text[position] === closing) {
        const raw = text.slice(start, position);
        return raw ? { start, end: position, value: decodeQuoted(raw, quote), explicit, assignment, quoted: true } : undefined;
      }
      position++;
    }
    // An unfinished pasted value must still be hidden while the user is typing.
    const raw = text.slice(start);
    return raw ? { start, end: text.length, value: decodeQuoted(raw, quote), explicit, assignment, quoted: true } : undefined;
  }
  const start = position;
  while (position < text.length && !/[\s，,；;。<>"'`]/u.test(text[position]!)) position++;
  let end = position;
  // Closing object delimiters and prose punctuation are not part of an unquoted value.
  while (end > start && /[}\]）]/u.test(text[end - 1]!)) end--;
  const value = text.slice(start, end);
  if (!value || value === SENSITIVE_TEXT_REDACTION || /^\*{3,}$|^•+$|^<[^>]*>$|^[?？。.!！]+$/u.test(value) || !assignment && ORDINARY_VALUE.test(value)) return undefined;
  return { start, end, value, explicit, assignment };
}

const NEXT_CONNECTION_FIELD = /^(?:(?:and|export|the)\s+)*["']?(?:(?:[a-z][a-z0-9]*[_-])*(?:api[_ -]?key|access[_ -]?key(?:[_ -]?secret)?|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|secret[_ -]?(?:access[_ -]?)?key|client[_ -]?secret|private[_ -]?key|password|passwd|passphrase|pwd|token|secret|user[_ -]?name|username|account|login|user|hostname|host|server|port|url|name)|[a-z][a-z0-9]*(?:Password|ApiKey|AccessToken|RefreshToken|PrivateKey|ClientSecret)|私钥密码|私钥口令|访问令牌|刷新令牌|访问密钥|访问秘钥|客户端密钥|客户端秘钥|API\s*密钥|API\s*秘钥|密码|口令|私钥|密钥|秘钥|令牌|登录账号|登录帐号|登录名|用户名|账号|帐号|账户|帐户|服务器地址|服务器|主机地址|主机|端口|网址|地址|连接名称|连接名|名称)["']?[\t ]*(?:[:：=]|是|为|\bis\b)/iu;
const NEXT_CONNECTION_INSTRUCTION = /^(?:(?:请|帮我|替我|给我)(?:帮我|你)?(?:记住|保存|存起来|记录|使用|登录|连接|部署|不要|别)|记住|保存|存起来|记录下来|不要泄露|不要保存|别保存|然后|接着|这是|用于|用来|(?:网站|网址|website|url)[\t ]+https?:\/\/|(?:please\s+(?:save|store|remember|use|log\s+in|connect))\b|(?:(?:remember|save|store)\s+(?:it|this|the))\b|(?:then|next)\b|this\s+is\b|(?:do\s+not|don't)\s+)/iu;

function readSecretValue(text: string, from: number, allowBare: boolean, quotedEnds?: ReadonlySet<number>, json?: JsonTextRanges): ParsedValue | undefined {
  const parsed = readValue(text, from, allowBare, quotedEnds);
  if (!parsed || parsed.quoted) return parsed;
  if (json) {
    const literal = json.literalAt.get(parsed.start);
    // JSON password flags are metadata, not the text of a credential. Numeric
    // credentials still need redaction, bounded to their value rather than prose.
    if (literal) return literal.kind === "number"
      ? { ...parsed, end: literal.end, value: text.slice(literal.start, literal.end) } : undefined;
    const string = json.ranges.find((range) => parsed.start >= range.start && parsed.start < range.end);
    if (string) {
      let end = string.end;
      for (let pos = parsed.start; pos < string.end; pos++) {
        if (text[pos] === "\\" && pos + 1 < string.end) {
          const escaped = text[pos + 1];
          if (escaped === "n" || escaped === "r") { end = pos; break; }
          pos++;
        }
      }
      while (end > parsed.start && /[\t ]/u.test(text[end - 1]!)) end--;
      if (end <= parsed.start) return undefined;
      return { ...parsed, end, value: decodeQuoted(text.slice(parsed.start, end), '"') };
    }
  }
  let end = text.length;
  for (let position = parsed.start; position < text.length; position++) {
    const character = text[position]!;
    if (!/[\s,，;；。]/u.test(character)) continue;
    let next = position + 1;
    while (next < text.length && /[\s,，;；。]/u.test(text[next]!)) next++;
    const rest = text.slice(next, next + 200);
    if (NEXT_CONNECTION_FIELD.test(rest) || NEXT_CONNECTION_INSTRUCTION.test(rest) || /^(?:```|~~~|\{[\t ]*["']|(?:https?|ssh|sftp):\/\/)/iu.test(rest)) {
      end = position;
      break;
    }
    position = next - 1;
  }
  // Spaces and commas are valid password characters. A bare value ends only at a
  // definite field/instruction boundary; taking its first word would leak the rest.
  while (end > parsed.start && /[\t \r\n]/u.test(text[end - 1]!)) end--;
  if (end <= parsed.start) return undefined;
  return { ...parsed, end, value: text.slice(parsed.start, end) };
}

function encodedVariants(value: string): string[] {
  const variants = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  try {
    const encoded = encodeURIComponent(value);
    variants.add(encoded);
    variants.add(encoded.replace(/%[A-F0-9]{2}/g, (part) => part.toLowerCase()));
    variants.add(encoded.replaceAll("%20", "+"));
  } catch { /* An isolated surrogate is still protected by its literal representation. */ }
  variants.add(value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));
  return [...variants].filter(Boolean);
}

function jsonStringBoundaries(text: string): JsonTextRanges | undefined {
  try { JSON.parse(text); } catch { return undefined; }
  const ranges: SecretSpan[] = [];
  const boundaries = new Set<number>();
  const literals: JsonLiteralSpan[] = [];
  const literalAt = new Map<number, JsonLiteralSpan>();
  for (let position = 0; position < text.length; position++) {
    if (text[position] !== '"') {
      const character = text[position]!;
      const literal = /[-0-9tfn]/u.test(character)
        ? text.slice(position).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0] : undefined;
      if (literal) {
        const span: JsonLiteralSpan = { start: position, end: position + literal.length,
          kind: literal === "null" ? "null" : literal === "true" || literal === "false" ? "boolean" : "number" };
        literals.push(span); literalAt.set(position, span);
        position = span.end - 1;
      }
      continue;
    }
    const start = ++position;
    boundaries.add(start);
    while (position < text.length && text[position] !== '"') {
      position += text[position] === "\\" ? text[position + 1] === "u" ? 6 : 2 : 1;
      boundaries.add(position);
    }
    ranges.push({ start, end: position });
  }
  return { ranges, boundaries, literals, literalAt };
}

function withKnownSpans(text: string, spans: SecretSpan[], secrets: readonly string[]): boolean {
  const shortPunctuation = (secret: string) => secret.length > 0 && secret.length < 4 && /^[^\p{L}\p{N}_]+$/u.test(secret);
  const json = secrets.some(shortPunctuation) ? jsonStringBoundaries(text) : undefined;
  const variants = new Map<string, { bounded: boolean; jsonContentOnly: boolean }>();
  for (const secret of secrets) {
    if (!secret) continue;
    const jsonContentOnly = Boolean(json && shortPunctuation(secret));
    const candidates = encodedVariants(secret).map((variant) => jsonContentOnly ? JSON.stringify(variant).slice(1, -1) : variant);
    if (jsonContentOnly && secret.length === 1) {
      const unicode = secret.charCodeAt(0).toString(16).padStart(4, "0");
      candidates.push(`\\u${unicode}`, `\\u${unicode.toUpperCase()}`);
      if (secret === "/") candidates.push("\\/");
    }
    for (const variant of candidates) {
      const previous = variants.get(variant);
      variants.set(variant, { bounded: (previous?.bounded ?? true) && secret.length < 4, jsonContentOnly: (previous?.jsonContentOnly ?? true) && jsonContentOnly });
    }
  }
  const wordCharacter = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}_]/u.test(character);
  for (const [variant, { bounded, jsonContentOnly }] of variants) {
    let from = 0;
    let rangeIndex = 0;
    while (from < text.length) {
      const found = text.indexOf(variant, from);
      if (found < 0) break;
      from = found + variant.length;
      if (jsonContentOnly && json) {
        while (json.ranges[rangeIndex] && json.ranges[rangeIndex]!.end < found) rangeIndex++;
        const range = json.ranges[rangeIndex];
        // JSON delimiters and partial escape sequences are syntax, not copies of a password.
        if (!range || found < range.start || from > range.end || !json.boundaries.has(found) || !json.boundaries.has(from)) continue;
        const nearbyStart = Math.max(range.start, found - 40);
        const nearby = text.slice(nearbyStart, Math.min(range.end, from + 40));
        if ([...nearby.matchAll(/\[(?:已隐藏|凭据已隐藏|自定义凭据已隐藏|REDACTED|HIDDEN)\]/giu)].some((match) => nearbyStart + match.index <= found && nearbyStart + match.index + match[0].length >= from)) continue;
      }
      // A one-character password must not erase that letter inside unrelated identifiers.
      if (bounded && !jsonContentOnly && (wordCharacter(text[found - 1]) || wordCharacter(text[from]))) continue;
      spans.push({ start: found, end: from });
      if (spans.length > MAX_REPLACEMENTS) return false;
    }
  }
  return true;
}

function replaceSpans(text: string, spans: SecretSpan[]): string {
  if (!spans.length) return text;
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const json = /^\s*(?:\{|\[)/u.test(text) ? jsonStringBoundaries(text) : undefined;
  const merged: SecretSpan[] = [];
  let literalIndex = 0;
  for (const original of sorted) {
    let span = original;
    while (json?.literals[literalIndex] && json.literals[literalIndex]!.end <= span.start) literalIndex++;
    const literal = json?.literals[literalIndex];
    if (literal && span.start >= literal.start && span.end <= literal.end) {
      if (literal.kind !== "number") continue;
      span = { start: literal.start, end: literal.end, quotedRedaction: true };
    }
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      if (previous.start !== span.start || previous.end !== span.end) delete previous.quotedRedaction;
      previous.end = Math.max(previous.end, span.end);
    }
    else merged.push({ ...span });
  }
  let safe = "";
  let from = 0;
  for (const span of merged) {
    safe += text.slice(from, span.start) + (span.quotedRedaction ? JSON.stringify(SENSITIVE_TEXT_REDACTION) : SENSITIVE_TEXT_REDACTION);
    from = span.end;
  }
  return safe + text.slice(from);
}

function normalizedLabel(label: string): string {
  return label.toLowerCase().replace(/[_\s-]/gu, "");
}

function urlMetadataAndSecrets(
  text: string,
  add: (kind: SensitiveSecretKind, value: string, start: number, end: number) => void,
  metadata: SensitiveTextInspection["metadata"],
): SecretSpan[] {
  const urls: SecretSpan[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[)\]}]+$/u, "");
    const start = match.index;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    urls.push({ start, end: start + raw.length });
    const authorityStart = raw.indexOf("://") + 3;
    const authorityEnd = raw.slice(authorityStart).search(/[/?#]/u);
    const authority = raw.slice(authorityStart, authorityEnd < 0 ? undefined : authorityStart + authorityEnd);
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(":");
      if (colon >= 0) {
        const password = userinfo.slice(colon + 1);
        if (password) add("password", safeDecode(password), start + authorityStart + colon + 1, start + authorityStart + at);
      }
      if (url.username && !metadata.username) metadata.username = safeDecode(url.username);
    }
    const query = raw.indexOf("?");
    if (query >= 0) {
      const queryEnd = raw.indexOf("#", query);
      const parameters = raw.slice(query + 1, queryEnd < 0 ? undefined : queryEnd);
      let offset = query + 1;
      for (const parameter of parameters.split("&")) {
        const equals = parameter.indexOf("=");
        if (equals >= 0) {
          const label = safeDecode(parameter.slice(0, equals), true);
          const normalized = normalizedLabel(label);
          const rawValue = parameter.slice(equals + 1);
          if (/^(?:key|apikey|accesskey|accesskeysecret|accesstoken|refreshtoken|authtoken|auth|authorization|secretkey|clientsecret|password|passwd|pwd|passphrase|token|secret|signature|sig|密码|密钥|秘钥|令牌)$/u.test(normalized) && rawValue) {
            add(secretKind(label), safeDecode(rawValue, true), start + offset + equals + 1, start + offset + parameter.length);
          }
        }
        offset += parameter.length + 1;
      }
    }
    if (url.protocol === "ssh:" || url.protocol === "sftp:") {
      metadata.kind = "ssh";
      metadata.host ??= url.hostname.replace(/^\[|\]$/gu, "");
      if (url.port) metadata.port ??= Number(url.port);
    } else if ((url.protocol === "http:" || url.protocol === "https:") && !metadata.url) {
      metadata.url = `${url.origin}${url.pathname}`;
    }
  }
  return urls;
}

function firstField(text: string, pattern: RegExp, allowBare: boolean, quotedEnds?: ReadonlySet<number>): string | undefined {
  for (const match of text.matchAll(pattern)) {
    const parsed = readValue(text, match.index + match[0].length, allowBare, quotedEnds);
    SECRET_LABEL.lastIndex = 0;
    const containsLabel = parsed && SECRET_LABEL.test(parsed.value);
    SECRET_LABEL.lastIndex = 0;
    if (parsed && !containsLabel) return parsed.value;
  }
  return undefined;
}

export interface SensitiveTextOptions {
  /** Only detect unambiguous credential formats (private keys, vendor API keys, auth headers, URL secrets), without prose label guessing. */
  definiteOnly?: boolean;
}

/** Detects supported credential formats before a message is persisted or sent to a model. */
export function inspectSensitiveText(text: string, options: SensitiveTextOptions = {}): SensitiveTextInspection {
  if (text.length > MAX_TEXT_LENGTH) {
    return { text: "[消息过长，敏感内容已隐藏]", secrets: [], saveRequested: false, metadata: {} };
  }
  const spans: SecretSpan[] = [];
  const quotedEnds = closingQuotes(text);
  const json = /^\s*(?:\{|\[)/u.test(text) ? jsonStringBoundaries(text) : undefined;
  const secrets: SensitiveTextInspection["secrets"] = [];
  const metadata: SensitiveTextInspection["metadata"] = {};
  const seen = new Set<string>();
  let overloaded = false;
  const add = (kind: SensitiveSecretKind, value: string, start: number, end: number) => {
    if (!value || value === SENSITIVE_TEXT_REDACTION || /^\*{3,}$|^•+$/u.test(value)) return;
    spans.push({ start, end });
    if (!seen.has(value)) { seen.add(value); secrets.push({ kind, value }); }
    if (secrets.length > MAX_SECRETS_PER_TEXT || spans.length > MAX_REPLACEMENTS) overloaded = true;
  };

  for (const match of text.matchAll(/-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gu)) {
    add("privateKey", match[0], match.index, match.index + match[0].length);
  }
  const urls = urlMetadataAndSecrets(text, add, metadata);
  const explicitSave = !options.definiteOnly && !/^\s*[\[{]/u.test(text) && SAVE_REQUEST.test(text) && !SAVE_NEGATION.test(text) && !/^(?:怎么|如何|怎样|讨论|\s*how\b)/iu.test(text.trim());
  const requestedCredentialContext = explicitSave && !DECLARATIVE_SAVE.test(text.trim()) && GENERIC_SAVE_COMMAND.test(text.trim()) && (STRONG_CREDENTIAL_CONTEXT.test(text) || !CODE_KEY_CONTEXT.test(text));
  if (!options.definiteOnly) {
    const protectedRanges = [...spans, ...urls].sort((a, b) => a.start - b.start);
    let protectedIndex = 0;
    let handledUntil = -1;
    for (const match of text.matchAll(SECRET_LABEL)) {
      if (overloaded) return { text: "[敏感内容过多，请通过连接授权分别填写]", secrets: [], saveRequested: false, metadata: {} };
      if (match.index < handledUntil) continue;
      while (protectedRanges[protectedIndex] && protectedRanges[protectedIndex]!.end <= match.index) protectedIndex++;
      const protectedRange = protectedRanges[protectedIndex];
      if (protectedRange && match.index >= protectedRange.start && match.index < protectedRange.end) continue;
      const chinese = /[\u3400-\u9fff]/u.test(match[0]);
      const bareArgument = /--$/u.test(text.slice(Math.max(0, match.index - 2), match.index));
      let valueFrom = match.index + match[0].length;
      if (match.index >= 2 && text.slice(match.index - 2, match.index) === "**" && text.startsWith("**", valueFrom)) {
        valueFrom += 2;
      }
      const parsed = readSecretValue(text, valueFrom, chinese || explicitSave || bareArgument, quotedEnds, json);
      if (!parsed) continue;
      handledUntil = parsed.end;
      let value = parsed.value;
      let start = parsed.start;
      if (/^(?:Bearer|Basic)\s+/iu.test(value)) {
        const prefix = value.match(/^(?:Bearer|Basic)\s+/iu)![0];
        value = value.slice(prefix.length);
        start += prefix.length;
      }
      add(secretKind(match[0]), value, start, parsed.end);
    }
    if (requestedCredentialContext) {
      const existingRanges = [...spans].sort((a, b) => a.start - b.start);
      let rangeIndex = 0;
      let aliasHandledUntil = -1;
      for (const match of text.matchAll(REQUESTED_CREDENTIAL_ALIAS)) {
        if (overloaded) return { text: "[敏感内容过多，请通过连接授权分别填写]", secrets: [], saveRequested: false, metadata: {} };
        if (match.index < aliasHandledUntil) continue;
        while (existingRanges[rangeIndex] && existingRanges[rangeIndex]!.end <= match.index) rangeIndex++;
        const existing = existingRanges[rangeIndex];
        if (existing && match.index >= existing.start && match.index < existing.end) continue;
        const parsed = readSecretValue(text, match.index + match[0].length, true, quotedEnds, json);
        if (parsed) {
          aliasHandledUntil = parsed.end;
          add("apiKey", parsed.value, parsed.start, parsed.end);
        }
      }
    }
  }
  for (const match of text.matchAll(/\b(?:Authorization|Proxy-Authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+([A-Za-z0-9._~+/%=-]{4,})/giu)) {
    const value = match[1]!;
    add("token", value, match.index + match[0].lastIndexOf(value), match.index + match[0].length);
  }
  for (const match of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/%=-]{8,})/gu)) {
    const value = match[1]!;
    if (/^[A-Za-z]{1,19}$/u.test(value)) continue;
    add("token", value, match.index + match[0].lastIndexOf(value), match.index + match[0].length);
  }
  const tokens: Array<[SensitiveSecretKind, RegExp]> = [
    ["apiKey", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/gu],
    ["token", /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu],
    ["token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu],
    ["apiKey", /\bAIza[A-Za-z0-9_-]{20,}/gu],
    ["apiKey", /\b(?:tvly-|xai-|pplx-|hf_|r8_)[A-Za-z0-9_-]{16,}/gu],
    ["apiKey", /\bBSA[A-Za-z0-9_-]{16,}/gu],
    ["apiKey", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu],
    ["apiKey", /\bak_[A-Za-z0-9_-]{16,}/gu],
    ["token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu],
  ];
  for (const [kind, pattern] of tokens) {
    for (const match of text.matchAll(pattern)) add(kind, match[0], match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(/\bsshpass\s+-p\s+/gu)) {
    const parsed = readValue(text, match.index + match[0].length, true, quotedEnds);
    if (parsed) add("password", parsed.value, parsed.start, parsed.end);
  }
  if (overloaded) return { text: "[敏感内容过多，请通过连接授权分别填写]", secrets: [], saveRequested: false, metadata: {} };
  const genericCredential = options.definiteOnly ? undefined : parseGenericCredential(text, secrets.map((secret) => secret.value));
  if (genericCredential?.fallback) return opaqueCredential(text, !SAVE_NEGATION.test(text));
  if (genericCredential) {
    for (const field of genericCredential.fields) add("apiKey", field.value, field.start, field.end);
  }
  if (requestedCredentialContext && !genericCredential) {
    const knownRanges = [...spans];
    withKnownSpans(text, knownRanges, [...secrets.map((secret) => secret.value), ...spans.map((span) => text.slice(span.start, span.end))]);
    const aliases = [...text.matchAll(SECRET_LABEL), ...text.matchAll(REQUESTED_CREDENTIAL_ALIAS)];
    const unparsedCandidate = aliases.some((match) => {
      if (knownRanges.some((span) => match.index >= span.start && match.index < span.end)) return false;
      if (readSecretValue(text, match.index + match[0].length, true, quotedEnds, json)) return false;
      const rawTail = text.slice(match.index + match[0].length);
      const leading = rawTail.match(/^["'\s:：=，,；;]+/u)?.[0].length ?? 0;
      const candidateStart = match.index + match[0].length + leading;
      if (knownRanges.some((span) => candidateStart >= span.start && candidateStart < span.end)) return false;
      const tail = rawTail.slice(leading).trim().replace(/^(?:是|为|is\b)[\t ]*[:：]?[\t ]*/iu, "");
      if (!tail || /^[。.!！?？\s]+$/u.test(tail) || tail.startsWith(SENSITIVE_TEXT_REDACTION) || ORDINARY_VALUE.test(tail)) return false;
      const alreadyRedactedTail = /\[(?:已隐藏|凭据已隐藏|自定义凭据已隐藏|REDACTED|HIDDEN)\]/iu.test(tail) &&
        tail.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).every((line) => {
          if (/^\[(?:连接|信息)已安全保存：[^\[\]\r\n=:：]{1,600}（connection-[a-f0-9-]{36}）[^\[\]\r\n]*\]$/iu.test(line)) return true;
          const sep = line.search(/[:：=]/u);
          if (sep <= 0) return false;
          const label = cleanFieldLabel(line.slice(0, sep));
          const val = line.slice(sep + 1).trim();
          return isCredentialPlaceholder(val) || PUBLIC_CREDENTIAL_FIELD.test(normalizedLabel(label));
        });
      return !alreadyRedactedTail;
    });
    if (unparsedCandidate) {
      return opaqueCredential(text, true);
    }
  }

  const ssh = text.match(/\bssh\s+(?:-[A-Za-z]\s+[^\s]+\s+)*(?:([A-Za-z0-9_.@\\-]+)@)?(\[[0-9a-f:]+\]|[A-Za-z0-9][A-Za-z0-9_.-]*)/iu);
  if (ssh) {
    metadata.kind = "ssh";
    metadata.host ??= ssh[2]!.replace(/^\[|\]$/gu, "");
    if (ssh[1]) metadata.username ??= ssh[1];
    const port = text.match(/(?:^|\s)-p\s+(\d{1,5})(?=[^\d]|$)/u);
    if (port) metadata.port ??= Number(port[1]);
  }
  metadata.username ??= firstField(text, ACCOUNT_LABEL, explicitSave || secrets.length > 0, quotedEnds);
  const host = firstField(text, HOST_LABEL, explicitSave || secrets.length > 0, quotedEnds);
  if (host && /^(?:\[[0-9a-f:]+\](?::\d+)?|[A-Za-z0-9][A-Za-z0-9_.:-]*)$/iu.test(host)) {
    const hostPort = host.match(/^(\[[0-9a-f:]+\]|[^:]+):(\d{1,5})$/iu);
    metadata.host ??= (hostPort?.[1] ?? host).replace(/^\[|\]$/gu, "");
    if (hostPort) metadata.port ??= Number(hostPort[2]);
  }
  const port = text.match(/(?:\bport\b|端口)[\t ]*(?:[:：=]|是|为)?[\t ]*(\d{1,5})(?=[^\d]|$)/iu);
  if (port) metadata.port ??= Number(port[1]);
  if (metadata.port !== undefined && (metadata.port < 1 || metadata.port > 65_535)) delete metadata.port;
  const name = firstField(text, /\bname\b|连接名称|连接名|名称/giu, false, quotedEnds);
  if (name) metadata.name = name.slice(0, 100);
  if (!metadata.kind && secrets.length) {
    metadata.kind = metadata.host || secrets.some((secret) => secret.kind === "privateKey") || /\bssh\b/iu.test(text)
      ? "ssh" : secrets.some((secret) => secret.kind === "apiKey" || secret.kind === "token") ? "api-key" : "account";
  }
  // An explicitly pasted account form implies a request to keep the connection, unless declined.
  const fieldsContext = !options.definiteOnly && !/^\s*[\[{]/u.test(text) && secrets.length > 0 && Boolean(metadata.username || metadata.host) && /[:：=]|账号|帐号|用户名/iu.test(text);
  const saveRequested = !options.definiteOnly && !SAVE_NEGATION.test(text) && (explicitSave || fieldsContext);
  const values = secrets.map((secret) => secret.value);
  const literalForms = spans.map((span) => text.slice(span.start, span.end));
  if (!withKnownSpans(text, spans, [...values, ...literalForms])) return { text: "[敏感内容已隐藏]", secrets, saveRequested, metadata: {} };
  // Metadata is persisted separately, so it must not retain a secret reused as a name or URL path.
  for (const key of ["name", "host", "username", "url"] as const) {
    const value = metadata[key];
    if (value) {
      const metadataSpans: SecretSpan[] = [];
      withKnownSpans(value, metadataSpans, values.filter((secret) => secret.length >= 4 || value === secret));
      if (metadataSpans.length) delete metadata[key];
    }
  }
  const customCredential = genericCredential ? sanitizedCustomCredential(genericCredential, values) : undefined;
  const safeText = customCredential ? `[凭据已隐藏]\n${customCredential.fields.map((field) => `${field.label}：${SENSITIVE_TEXT_REDACTION}`).join("\n")}` : replaceSpans(text, spans);
  return { text: safeText, secrets, saveRequested, metadata, ...(saveRequested && customCredential ? { customCredential } : {}) };
}

/** Also hides previously stored secrets echoed without a recognizable credential label. */
export function redactSensitiveText(text: string, knownSecrets: readonly string[] = [], options?: SensitiveTextOptions): string {
  const inspected = inspectSensitiveText(text, options);
  if (!knownSecrets.length || inspected.text !== text && inspected.text.startsWith("[消息过长")) return inspected.text;
  const spans: SecretSpan[] = [];
  if (!withKnownSpans(inspected.text, spans, knownSecrets)) return "[敏感内容已隐藏]";
  return replaceSpans(inspected.text, spans);
}
