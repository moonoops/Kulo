/**
 * Deterministic POSIX shell safety floor & outward-action classifier shared across
 * Hub orchestrator bash, built-in Worker bash, Host maintenance actions, and external CLI logs.
 *
 * Zero external dependencies; bounded to 32 KiB input and 3 nested `sh -c` levels.
 */

export type ShellSafetyVerdict = "safe" | "block" | "unreadable";

export interface ShellSafetyResult {
  verdict: ShellSafetyVerdict;
  reason?: string;
}

export interface ShellSafetyOptions {
  /** Also block destructive force pushes (`git push --force` / `-f`). Enabled for background Workers. */
  blockForcePush?: boolean;
}

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_NESTING_DEPTH = 3;

const SHELL_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nohup",
  "time",
  "nice",
  "exec",
  "builtin",
  "timeout",
  "stdbuf",
]);

const INLINE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

const PROTECTED_TOP_DIRS = new Set([
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/var",
  "/lib",
  "/lib64",
  "/opt",
  "/system",
  "/library",
  "/users",
  "/applications",
  "/volumes",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/home",
  "/private",
]);

const DISKUTIL_DESTRUCTIVE_SUBCOMMANDS = new Set([
  "erasedisk",
  "erasevolume",
  "eraseoptical",
  "zerodisk",
  "randomdisk",
  "partitiondisk",
  "reformat",
]);

const SAFE_DEV_OUTPUTS = /^\/dev\/(?:null|zero|stdout|stderr|tty|fd\/\d+)$/i;

const FORK_BOMB_RE =
  /(?:^|[;&|\s\n])([A-Za-z_:]\w*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;\s*\1(?:\s|$|[;&|])/;

interface TokenizeResult {
  ok: boolean;
  reason?: string;
  commands: string[][];
  substitutions: string[];
}

function isWordBoundary(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")";
}

/**
 * Lightweight POSIX lexer supporting quotes, backslash escapes, `#` comments,
 * `$((...))` / `((...))` arithmetic expressions (avoiding false heredoc on `<<`),
 * `<<EOF` heredocs, and `$(...)` / backtick command substitutions.
 */
function tokenizePosix(input: string): TokenizeResult {
  if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_BYTES) {
    return { ok: false, reason: "command_too_long", commands: [], substitutions: [] };
  }

  const commands: string[][] = [];
  const substitutions: string[] = [];
  let currentCmd: string[] = [];
  let currentWord = "";
  let inWord = false;
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

  const pushWord = () => {
    if (inWord) {
      currentCmd.push(currentWord);
      currentWord = "";
      inWord = false;
    }
  };

  const pushCmd = () => {
    pushWord();
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
      currentCmd = [];
    }
  };

  const len = input.length;
  let i = 0;

  const consumeHeredocsAfterNewline = (): boolean => {
    while (pendingHeredocs.length > 0) {
      const hd = pendingHeredocs.shift()!;
      let matched = false;
      while (i < len) {
        const lineEnd = input.indexOf("\n", i);
        const end = lineEnd === -1 ? len : lineEnd;
        let line = input.slice(i, end);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        i = lineEnd === -1 ? len : lineEnd + 1;
        const candidate = hd.stripTabs ? line.replace(/^\t+/, "") : line;
        if (candidate === hd.delimiter) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  };

  /** Consumes `$(...)` starting at index of `$` (so `input[start] === '$' && input[start+1] === '('`). */
  const consumeDollarParen = (start: number): { next: number; ok: boolean } => {
    // Handle arithmetic expansion `$(( ... ))` first so `<<` inside arithmetic is never treated as heredoc.
    if (input[start + 2] === "(") {
      let j = start + 3;
      let depth = 1;
      while (j < len && depth > 0) {
        const ch = input[j]!;
        if (ch === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (ch === "$" && input[j + 1] === "(") {
          const sub = consumeDollarParen(j);
          if (!sub.ok) return sub;
          j = sub.next;
          continue;
        }
        if (ch === "`") {
          const sub = consumeBacktick(j);
          if (!sub.ok) return sub;
          j = sub.next;
          continue;
        }
        if (ch === "(" && input[j + 1] === "(") {
          depth += 1;
          j += 2;
          continue;
        }
        if (ch === ")" && input[j + 1] === ")") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      return depth === 0 ? { next: j, ok: true } : { next: j, ok: false };
    }

    let j = start + 2;
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    while (j < len && depth > 0) {
      const ch = input[j]!;
      if (inSingle) {
        if (ch === "'") inSingle = false;
        j += 1;
        continue;
      }
      if (ch === "\\" && j + 1 < len) {
        j += 2;
        continue;
      }
      if (inDouble) {
        if (ch === '"') inDouble = false;
        else if (ch === "$" && input[j + 1] === "(") {
          const sub = consumeDollarParen(j);
          if (!sub.ok) return sub;
          j = sub.next;
          continue;
        } else if (ch === "`") {
          const sub = consumeBacktick(j);
          if (!sub.ok) return sub;
          j = sub.next;
          continue;
        }
        j += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          substitutions.push(input.slice(start + 2, j));
          return { next: j + 1, ok: true };
        }
      }
      j += 1;
    }
    return { next: j, ok: false };
  };

  const consumeBacktick = (start: number): { next: number; ok: boolean } => {
    let j = start + 1;
    let body = "";
    while (j < len) {
      const ch = input[j]!;
      if (ch === "\\" && j + 1 < len) {
        const nextCh = input[j + 1]!;
        if (nextCh === "`" || nextCh === "\\" || nextCh === "$") {
          body += nextCh;
          j += 2;
          continue;
        }
      }
      if (ch === "`") {
        substitutions.push(body);
        return { next: j + 1, ok: true };
      }
      body += ch;
      j += 1;
    }
    return { next: j, ok: false };
  };

  while (i < len) {
    const ch = input[i]!;

    // Newline ends current command and consumes any queued heredoc bodies.
    if (ch === "\n") {
      pushCmd();
      i += 1;
      if (pendingHeredocs.length > 0 && !consumeHeredocsAfterNewline()) {
        return { ok: false, reason: "unclosed_heredoc", commands, substitutions };
      }
      continue;
    }

    // Horizontal whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i += 1;
      continue;
    }

    // Comment starts only at token boundary
    if (ch === "#" && !inWord) {
      const nl = input.indexOf("\n", i);
      i = nl === -1 ? len : nl;
      continue;
    }

    // Standalone arithmetic command `(( ... ))` at command boundary
    if (ch === "(" && input[i + 1] === "(" && !inWord) {
      pushCmd();
      let j = i + 2;
      let depth = 1;
      while (j < len && depth > 0) {
        const cur = input[j]!;
        if (cur === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (cur === "$" && input[j + 1] === "(") {
          const sub = consumeDollarParen(j);
          if (!sub.ok) return { ok: false, reason: "unclosed_subshell", commands, substitutions };
          j = sub.next;
          continue;
        }
        if (cur === "`") {
          const sub = consumeBacktick(j);
          if (!sub.ok) return { ok: false, reason: "unclosed_backtick", commands, substitutions };
          j = sub.next;
          continue;
        }
        if (cur === "(" && input[j + 1] === "(") {
          depth += 1;
          j += 2;
          continue;
        }
        if (cur === ")" && input[j + 1] === ")") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      if (depth !== 0) {
        return { ok: false, reason: "unclosed_arithmetic", commands, substitutions };
      }
      i = j;
      continue;
    }

    // Command separators
    if (ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      if ((ch === "{" || ch === "}") && inWord) {
        currentWord += ch;
        i += 1;
        continue;
      }
      pushCmd();
      i += 1;
      continue;
    }

    if (ch === "&" || ch === "|") {
      // Handle `>&`, `2>&1` redirections without splitting on `&` inside a redirection
      if (ch === "&" && i > 0 && (input[i - 1] === ">" || input[i - 1] === "<")) {
        currentWord += ch;
        inWord = true;
        i += 1;
        continue;
      }
      pushCmd();
      if ((ch === "&" && input[i + 1] === "&") || (ch === "|" && (input[i + 1] === "|" || input[i + 1] === "&"))) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // Here-string `<<<` vs Heredoc `<<` / `<<-`
    if (ch === "<" && input[i + 1] === "<") {
      if (input[i + 2] === "<") {
        pushWord();
        i += 3;
        continue;
      }
      pushWord();
      let j = i + 2;
      let stripTabs = false;
      if (input[j] === "-") {
        stripTabs = true;
        j += 1;
      }
      while (j < len && (input[j] === " " || input[j] === "\t")) j += 1;
      let delimiter = "";
      while (j < len && !isWordBoundary(input[j]!) && input[j] !== "<" && input[j] !== ">") {
        const dch = input[j]!;
        if (dch === "'" || dch === '"') {
          const quote = dch;
          j += 1;
          while (j < len && input[j] !== quote) {
            if (quote === '"' && input[j] === "\\" && j + 1 < len) {
              delimiter += input[j + 1]!;
              j += 2;
              continue;
            }
            delimiter += input[j]!;
            j += 1;
          }
          if (j >= len) return { ok: false, reason: "unclosed_heredoc_delimiter", commands, substitutions };
          j += 1;
        } else if (dch === "\\" && j + 1 < len) {
          delimiter += input[j + 1]!;
          j += 2;
        } else {
          delimiter += dch;
          j += 1;
        }
      }
      if (!delimiter) return { ok: false, reason: "missing_heredoc_delimiter", commands, substitutions };
      pendingHeredocs.push({ delimiter, stripTabs });
      i = j;
      continue;
    }

    // Single-quoted literal
    if (ch === "'") {
      inWord = true;
      const close = input.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: "unclosed_single_quote", commands, substitutions };
      currentWord += input.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    // ANSI-C quoting `$'...'`
    if (ch === "$" && input[i + 1] === "'") {
      inWord = true;
      let j = i + 2;
      while (j < len && input[j] !== "'") {
        if (input[j] === "\\" && j + 1 < len) {
          currentWord += input[j + 1]!;
          j += 2;
          continue;
        }
        currentWord += input[j]!;
        j += 1;
      }
      if (j >= len) return { ok: false, reason: "unclosed_ansi_quote", commands, substitutions };
      i = j + 1;
      continue;
    }

    // Double-quoted string (scans nested `$(...)` and backticks)
    if (ch === '"') {
      inWord = true;
      let j = i + 1;
      while (j < len && input[j] !== '"') {
        const dch = input[j]!;
        if (dch === "\\" && j + 1 < len) {
          const nextCh = input[j + 1]!;
          if (nextCh === "\n") {
            j += 2;
            continue;
          }
          if (nextCh === '"' || nextCh === "\\" || nextCh === "$" || nextCh === "`") {
            currentWord += nextCh;
            j += 2;
            continue;
          }
        }
        if (dch === "$" && input[j + 1] === "(") {
          const sub = consumeDollarParen(j);
          if (!sub.ok) return { ok: false, reason: "unclosed_subshell", commands, substitutions };
          currentWord += input.slice(j, sub.next);
          j = sub.next;
          continue;
        }
        if (dch === "`") {
          const sub = consumeBacktick(j);
          if (!sub.ok) return { ok: false, reason: "unclosed_backtick", commands, substitutions };
          currentWord += input.slice(j, sub.next);
          j = sub.next;
          continue;
        }
        currentWord += dch;
        j += 1;
      }
      if (j >= len) return { ok: false, reason: "unclosed_double_quote", commands, substitutions };
      i = j + 1;
      continue;
    }

    // Command substitution / arithmetic outside quotes
    if (ch === "$" && input[i + 1] === "(") {
      inWord = true;
      const sub = consumeDollarParen(i);
      if (!sub.ok) return { ok: false, reason: "unclosed_subshell", commands, substitutions };
      currentWord += input.slice(i, sub.next);
      i = sub.next;
      continue;
    }

    if (ch === "`") {
      inWord = true;
      const sub = consumeBacktick(i);
      if (!sub.ok) return { ok: false, reason: "unclosed_backtick", commands, substitutions };
      currentWord += input.slice(i, sub.next);
      i = sub.next;
      continue;
    }

    // Backslash escape outside quotes
    if (ch === "\\" && i + 1 < len) {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      inWord = true;
      currentWord += input[i + 1]!;
      i += 2;
      continue;
    }

    inWord = true;
    currentWord += ch;
    i += 1;
  }

  pushCmd();
  if (pendingHeredocs.length > 0) {
    return { ok: false, reason: "unclosed_heredoc", commands, substitutions };
  }
  return { ok: true, commands, substitutions };
}

function commandBasename(word: string): string {
  const slash = word.lastIndexOf("/");
  return (slash >= 0 ? word.slice(slash + 1) : word).toLowerCase();
}

function stripLeadingAssignmentsAndWrappers(words: readonly string[]): string[] {
  let idx = 0;
  while (idx < words.length) {
    const w = words[idx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      idx += 1;
      continue;
    }
    const base = commandBasename(w);
    if (!SHELL_WRAPPERS.has(base)) break;
    idx += 1;
    // Skip wrapper options (e.g., `sudo -u root`, `env -i FOO=1`, `timeout 10`, `nice -n 5`)
    while (idx < words.length) {
      const arg = words[idx]!;
      if (arg === "--") {
        idx += 1;
        break;
      }
      if (base === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        idx += 1;
        continue;
      }
      if (base === "timeout" && idx > 0 && /^\d+(?:\.\d+)?[smhd]?$/.test(arg)) {
        idx += 1;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        idx += 1;
        // Flags that take a separate value argument
        if (
          (base === "sudo" && /^-[ugpChrt]$/.test(arg)) ||
          (base === "doas" && /^-[uC]$/.test(arg)) ||
          (base === "env" && /^-[uCS]$/.test(arg)) ||
          (base === "nice" && arg === "-n") ||
          (base === "timeout" && /^-[ks]$/.test(arg))
        ) {
          idx += 1;
        }
        continue;
      }
      break;
    }
  }
  return words.slice(idx);
}

function normalizePosixTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Keep home variable forms explicit
  if (/^(?:~|\$HOME|\$\{HOME\})(?:\/\*?)?$/i.test(trimmed)) {
    return "$HOME";
  }
  const hasTrailingGlob = /\/\*+$/.test(trimmed);
  const strippedGlob = hasTrailingGlob ? trimmed.replace(/\/\*+$/, "") || "/" : trimmed;
  if (!strippedGlob.startsWith("/")) return strippedGlob;

  const parts = strippedGlob.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

function isCatastrophicRmTarget(rawOperand: string): string | undefined {
  const norm = normalizePosixTarget(rawOperand);
  if (!norm) return undefined;
  if (norm === "/") return "recursive_delete_root";
  if (norm === "$HOME") return "recursive_delete_home";
  if (PROTECTED_TOP_DIRS.has(norm.toLowerCase())) return `recursive_delete_system_dir:${norm}`;
  return undefined;
}

function extractInlineShellScript(words: readonly string[]): string | undefined {
  if (words.length < 3) return undefined;
  const base = commandBasename(words[0]!);
  if (!INLINE_SHELLS.has(base)) return undefined;
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]!;
    if (arg === "--") break;
    if (arg === "-c" || (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c"))) {
      return words[i + 1];
    }
  }
  return undefined;
}

function classifySingleCommand(words: readonly string[], depth: number, options: ShellSafetyOptions): ShellSafetyResult {
  const stripped = stripLeadingAssignmentsAndWrappers(words);
  if (stripped.length === 0) return { verdict: "safe" };

  const base = commandBasename(stripped[0]!);

  // Unwrap `sh -c "..."`, `bash -lc "..."`, etc.
  const nestedScript = extractInlineShellScript(stripped);
  if (nestedScript !== undefined) {
    if (depth >= MAX_NESTING_DEPTH) {
      return { verdict: "unreadable", reason: "shell_nesting_limit" };
    }
    const nested = classifyShellSafetyFloorInternal(nestedScript, depth + 1, options);
    if (nested.verdict !== "safe") return nested;
  }

  // 1. Recursive `rm` against root, $HOME, or top-level system directories
  if (base === "rm") {
    let recursive = false;
    let endOfFlags = false;
    const operands: string[] = [];
    for (let i = 1; i < stripped.length; i++) {
      const arg = stripped[i]!;
      if (!endOfFlags && arg === "--") {
        endOfFlags = true;
        continue;
      }
      if (!endOfFlags && arg.startsWith("-") && arg.length > 1) {
        if (arg === "--recursive" || (!arg.startsWith("--") && /[rR]/.test(arg.slice(1)))) {
          recursive = true;
        }
        continue;
      }
      operands.push(arg);
    }
    if (recursive) {
      for (const operand of operands) {
        const hit = isCatastrophicRmTarget(operand);
        if (hit) return { verdict: "block", reason: hit };
      }
    }
    return { verdict: "safe" };
  }

  // 2. Filesystem formatting / block-device wiping
  if (
    base === "mkfs" ||
    base.startsWith("mkfs.") ||
    base === "newfs" ||
    base.startsWith("newfs_") ||
    base === "mke2fs" ||
    base === "mkswap"
  ) {
    return { verdict: "block", reason: `format_filesystem:${base}` };
  }

  if (base === "diskutil") {
    const sub = (stripped[1] ?? "").toLowerCase();
    const sub2 = (stripped[2] ?? "").toLowerCase();
    if (
      DISKUTIL_DESTRUCTIVE_SUBCOMMANDS.has(sub) ||
      (sub === "apfs" && (sub2 === "deletecontainer" || sub2 === "deletevolume"))
    ) {
      return { verdict: "block", reason: `diskutil_destructive:${sub}` };
    }
  }

  if (base === "dd") {
    for (const arg of stripped.slice(1)) {
      if (/^of=\/dev\//i.test(arg)) {
        const target = arg.slice(3);
        if (!SAFE_DEV_OUTPUTS.test(target)) {
          return { verdict: "block", reason: `dd_raw_device:${target}` };
        }
      }
    }
  }

  if (
    (base === "shred" || base === "wipefs" || base === "blkdiscard" || base === "fdisk" || base === "parted" || base === "sgdisk") &&
    stripped.slice(1).some((arg) => /^\/dev\//i.test(arg) && !SAFE_DEV_OUTPUTS.test(arg))
  ) {
    return { verdict: "block", reason: `raw_disk_tool:${base}` };
  }

  if (options.blockForcePush && base === "git") {
    let i = 1;
    while (i < stripped.length) {
      const arg = stripped[i]!;
      if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if ((stripped[i] ?? "").toLowerCase() === "push") {
      const pushArgs = stripped.slice(i + 1);
      const isForce = pushArgs.some(
        (arg) =>
          arg === "--force" ||
          arg === "-f" ||
          (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f")),
      );
      if (isForce) {
        return { verdict: "block", reason: "git_force_push" };
      }
    }
  }

  return { verdict: "safe" };
}

function classifyShellSafetyFloorInternal(command: string, depth: number, options: ShellSafetyOptions): ShellSafetyResult {
  if (!command || !command.trim()) return { verdict: "safe" };
  if (FORK_BOMB_RE.test(command)) {
    return { verdict: "block", reason: "fork_bomb" };
  }

  const parsed = tokenizePosix(command);
  if (!parsed.ok) {
    return { verdict: "unreadable", reason: parsed.reason };
  }

  for (const sub of parsed.substitutions) {
    if (depth >= MAX_NESTING_DEPTH) {
      return { verdict: "unreadable", reason: "shell_nesting_limit" };
    }
    const subRes = classifyShellSafetyFloorInternal(sub, depth + 1, options);
    if (subRes.verdict !== "safe") return subRes;
  }

  for (const words of parsed.commands) {
    const res = classifySingleCommand(words, depth, options);
    if (res.verdict !== "safe") return res;
  }

  return { verdict: "safe" };
}

/**
 * Classifies a POSIX shell command string against Kulo's deterministic safety floor.
 * - `"block"`: definitely catastrophic (root/home/system rm -r, mkfs, diskutil erase, raw dd, fork bomb).
 * - `"unreadable"`: unparseable or exceeds size/nesting bounds (callers decide fail-closed vs warn).
 * - `"safe"`: cleared by the static floor (subject to OS sandbox & path policies).
 */
export function classifyShellSafetyFloor(command: string, options: ShellSafetyOptions = {}): ShellSafetyResult {
  return classifyShellSafetyFloorInternal(command, 0, options);
}

function detectOutwardInSingleCommand(words: readonly string[], depth: number, out: Set<string>): void {
  const stripped = stripLeadingAssignmentsAndWrappers(words);
  if (stripped.length === 0) return;

  const base = commandBasename(stripped[0]!);
  const nestedScript = extractInlineShellScript(stripped);
  if (nestedScript !== undefined && depth < MAX_NESTING_DEPTH) {
    detectOutwardInternal(nestedScript, depth + 1, out);
  }

  const hasDryRun = stripped.some((arg) => arg === "--dry-run" || arg === "-n");

  if (base === "git") {
    // Skip global git flags (`-C <dir>`, `-c <k=v>`, `--git-dir=...`, `--work-tree=...`)
    let i = 1;
    while (i < stripped.length) {
      const arg = stripped[i]!;
      if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    const sub = (stripped[i] ?? "").toLowerCase();
    if (sub === "push" && !hasDryRun) {
      out.add("shell:git push");
    }
    return;
  }

  if (base === "npm" || base === "pnpm" || base === "yarn" || base === "cargo") {
    const sub = stripped.slice(1).find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (sub === "publish" && !hasDryRun) {
      out.add(`shell:${base} publish`);
    }
    return;
  }

  if (base === "twine") {
    const sub = stripped.slice(1).find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (sub === "upload") {
      out.add("shell:twine upload");
    }
    return;
  }

  if (base === "docker" || base === "podman") {
    const sub = stripped.slice(1).find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (sub === "push") {
      out.add(`shell:${base} push`);
    }
    return;
  }

  if (base === "gh") {
    const positionals = stripped.slice(1).filter((arg) => !arg.startsWith("-")).map((arg) => arg.toLowerCase());
    const [sub1, sub2] = positionals;
    if (
      (sub1 === "pr" && (sub2 === "create" || sub2 === "merge" || sub2 === "comment" || sub2 === "review")) ||
      (sub1 === "issue" && (sub2 === "create" || sub2 === "comment")) ||
      (sub1 === "release" && sub2 === "create")
    ) {
      out.add(`shell:gh ${sub1} ${sub2}`);
    }
  }
}

function detectOutwardInternal(command: string, depth: number, out: Set<string>): void {
  if (!command || !command.trim() || depth > MAX_NESTING_DEPTH) return;
  const parsed = tokenizePosix(command);
  if (!parsed.ok) return;
  for (const sub of parsed.substitutions) {
    detectOutwardInternal(sub, depth + 1, out);
  }
  for (const words of parsed.commands) {
    detectOutwardInSingleCommand(words, depth, out);
  }
}

/**
 * Extracts normalized labels for outward side-effect commands (e.g. `git push`, `npm publish`, `gh pr create`)
 * using the same POSIX lexer so dry-runs, comments, and quoted commit messages are ignored.
 */
export function detectOutwardShellCommands(command: string): string[] {
  const out = new Set<string>();
  detectOutwardInternal(command, 0, out);
  return [...out];
}

const EXTERNAL_TOOL_PREFIX_RE = /^(?:bash|shell|terminal|run(?:_command)?|exec(?:ute)?)\s*[:\-]?\s+/i;

/**
 * Extracts outward side-effect command labels from external CLI tool-event summaries
 * (e.g. Claude Code's `Bash git push origin main` or ACP's `Run npm publish`).
 */
export function detectOutwardShellCommandsFromToolText(toolText: string): string[] {
  const trimmed = toolText.trim();
  if (!trimmed) return [];
  const stripped = trimmed.replace(EXTERNAL_TOOL_PREFIX_RE, "");
  return detectOutwardShellCommands(stripped);
}
