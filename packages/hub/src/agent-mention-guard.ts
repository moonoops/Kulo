const RESERVED_AT_KEYWORDS: ReadonlySet<string> = new Set([
  // JSDoc / TSDoc / Javadoc / TypeScript directives
  "param", "return", "returns", "throws", "exception", "type", "typedef", "template",
  "callback", "property", "prop", "deprecated", "see", "link", "example", "since",
  "version", "author", "default", "readonly", "satisfies",
  "ts-ignore", "ts-expect-error", "ts-nocheck", "ts-check",
  // Java / Kotlin / Spring / JUnit annotations
  "override", "bean", "autowired", "component", "service", "repository", "controller",
  "restcontroller", "requestmapping", "getmapping", "postmapping", "putmapping",
  "deletemapping", "patchmapping", "transactional", "configuration", "value",
  "qualifier", "inject", "singleton", "nullable", "nonnull", "notnull",
  "suppresswarnings", "functionalinterface", "test", "beforeeach", "aftereach",
  "beforeall", "afterall", "parameterizedtest",
  // Python / Swift / ObjC decorators & attributes
  "dataclass", "staticmethod", "classmethod", "abstractmethod", "contextmanager",
  "asynccontextmanager", "lru_cache", "cache", "cached_property", "pytest", "fixture",
  "mainactor", "objc", "available", "published", "state", "binding", "observedobject",
  "environment", "interface", "protocol", "synthesize", "dynamic",
  // CSS at-rules & batch directives
  "media", "import", "keyframes", "layer", "supports", "tailwind", "apply", "charset",
  "font-face", "namespace", "page", "counter-style", "container", "scope",
  "starting-style", "echo", "rem", "endif",
  // Assembly / ELF symbol types
  "function", "object", "tls_object", "gnu_indirect_function", "gnu_unique_object",
  "progbits", "nobits", "note", "notype",
]);

const canonicalToken = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

const blankPreservingNewlines = (segment: string): string => segment.replace(/[^\r\n]/g, " ");

function isKnownToken(rawToken: string, knownNames: ReadonlySet<string>): boolean {
  const full = canonicalToken(rawToken);
  if (knownNames.has(full)) return true;
  const head = full.split(".")[0];
  return Boolean(head && knownNames.has(head));
}

/**
 * Replaces non-conversational `@` syntax (unfenced assembly directives, ELF relocations,
 * scoped packages, SSH `user@host:` specs, code comments, and decorators/CSS at-rules
 * not matching configured `knownNames`) with equal-length spaces while preserving
 * Markdown indented lists (`    - @agent` / `    1. @agent`).
 */
export function maskNonConversationalAtTokens(
  text: string,
  knownNames: ReadonlySet<string>,
): string {
  return text
    .replace(
      /^(?: {4,}|\t+)(?![-*+]\s|\d+[.)]\s)(?=[^\n]*(?:[{}();=<>[\]]|^\s*(?:\.|#|\/\/|\/\*|\*)))[^\n]*/gm,
      blankPreservingNewlines,
    )
    .replace(
      /^[ \t]*\.(?:type|globl|global|section|rodata|text|data|bss|align|p2align|balign|cfi_\w+|size|ident|file|comm|lcomm|weak|hidden|protected|internal|symver)\b[^\n]*/gim,
      blankPreservingNewlines,
    )
    .replace(
      /,\s*@(?:function|object|tls_object|gnu_indirect_function|gnu_unique_object|progbits|nobits|note|init_array|fini_array|preinit_array|notype)\b/gi,
      blankPreservingNewlines,
    )
    .replace(
      /\b[\w.$]+@(?:PLT|GOT|GOTOFF|GOTPCREL|GOTPCREL64|TLSGD|TLSLD|TPOFF|DTPOFF|NTPOFF|PAGE|PAGEOFF|GOTPAGE|GOTPAGEOFF|AUTH)\b/g,
      blankPreservingNewlines,
    )
    .replace(/(?<![\w])@[a-z0-9][\w.-]*\/[\w./-]+/gi, blankPreservingNewlines)
    .replace(/[/\\]@[A-Za-z0-9_][\w.-]*/g, blankPreservingNewlines)
    .replace(
      /\b[\w.-]+@(?:[\w-]+(?:\.[\w-]+)+|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::[\w./~-]*)?/gi,
      blankPreservingNewlines,
    )
    .replace(/^[ \t]*(?:\/\/|\/\*+|\*(?!\*)|#|--|;)[ \t]*@([\p{L}\p{N}_][\p{L}\p{N}_.:-]*)/gmu, (full, token: string) =>
      isKnownToken(token, knownNames) ? full : blankPreservingNewlines(full),
    )
    .replace(/(^|\s)(?:\/\/|\/\*+)[ \t]*@([\p{L}\p{N}_][\p{L}\p{N}_.:-]*)/gu, (full, lead: string, token: string) =>
      isKnownToken(token, knownNames) ? full : `${lead}${blankPreservingNewlines(full.slice(lead.length))}`,
    )
    .replace(
      /^([ \t]*)@([A-Za-z_][\w.]*)(?=[ \t]*(?:\(|$|\r?\n|(?:async\s+)?(?:def|function|class|interface|enum|type|struct|impl|fn|pub|public|private|protected|static|final|abstract|override|export)\b))/gm,
      (full, indent: string, token: string) =>
        isKnownToken(token, knownNames) ? full : `${indent}${" ".repeat(full.length - indent.length)}`,
    )
    .replace(/@([A-Za-z_][\w.-]*)/g, (full, token: string) => {
      if (isKnownToken(token, knownNames)) return full;
      const lower = canonicalToken(token);
      const head = lower.split(".")[0]!;
      if (
        RESERVED_AT_KEYWORDS.has(lower) ||
        RESERVED_AT_KEYWORDS.has(head) ||
        /^(?:app|router|blueprint|celery|click|typer)\.[a-z_]/i.test(lower)
      ) {
        return blankPreservingNewlines(full);
      }
      return full;
    });
}

export interface UnknownAtIntentCheckInput {
  before: string;
  after: string;
  between: string;
  hasVerb: boolean;
}

export function hasExplicitUnknownAtIntent(input: UnknownAtIntentCheckInput): boolean {
  const { before, after, between, hasVerb } = input;
  if (
    hasVerb &&
    between.length <= 120 &&
    !/(?:介绍|解释|比较|对比)|\b(?:explain|compare)\b/i.test(between) &&
    !/[=;<>{}[\]()]/.test(between)
  ) {
    return true;
  }
  const prefixBeforeAt = before.endsWith("@") ? before.slice(0, -1) : before;
  const strippedBefore = prefixBeforeAt
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/@[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,79}/gu, "")
    .replace(/[*_~]+/g, "")
    .replace(/[\s,，、:：]|和|与|或|以及|\b(?:and|or)\b/giu, "");
  if (strippedBefore.length > 0) return false;
  const tailAfterMentions = after
    .replace(/^[*_~]+/, "")
    .replace(
      /^(?:\s*(?:[,，、]|和|与|或|以及|\b(?:and|or)\b)?\s*[*_~]*@[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,79}[*_~]*)+/giu,
      "",
    );
  const match = /^(?:\s*[,，:：]\s*|\s+)(.+)$/su.exec(tailAfterMentions);
  if (!match) return false;
  const body = match[1]!.trim();
  if (/^[=();{}[\]./*+\-<>|&^%~]/.test(body)) return false;
  return (body.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2;
}
