import path from "node:path";

/**
 * Pure workspace inference for unbound (no project, no explicit `workspace_dir`) read-only tickets.
 * Without it such tickets run inside a freshly created, empty `table/<ticket>` directory and cannot
 * see the files they were asked to inspect. Writable tickets keep their isolated `table/` directory
 * so write-lock scopes and parallel dispatch stay unchanged.
 */
export interface DispatchWorkspaceInferenceInput {
  /** Root directory registered by the target Env (`EnvNodeDescriptor.rootDir`). */
  envRootDir: string;
  isReadOnly: boolean;
  /** Text fields of the ticket that may reference absolute paths on the target Env. */
  texts: readonly (string | undefined)[];
  /** Absolute paths the coordinator already read or edited on the same Env during this turn. */
  coordinatorReadPaths?: readonly string[];
  /** True when the target is a remote Env whose root is a dedicated workspace (see `isDedicatedRemoteRoot`). */
  isRemoteDedicatedRoot?: boolean;
}

export type DispatchWorkspaceInference =
  | { kind: "inferred"; dir: string }
  | { kind: "env_root_readonly"; dir: string }
  | { kind: "default" };

const MAX_REFERENCES = 64;

function pathApiFor(root: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
}

function isInside(api: typeof path.posix | typeof path.win32, root: string, candidate: string): boolean {
  const relative = api.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

/** Absolute POSIX or Win32 paths written in free text (quotes, backticks and trailing punctuation removed). */
export function extractAbsolutePaths(text: string, api: typeof path.posix | typeof path.win32 = path.posix): string[] {
  const found: string[] = [];
  const pattern = api === path.win32
    ? /(?:^|[\s"'`(（「:：,，])([A-Za-z]:\\(?:[^\s"'`<>|*?\r\n\\]+\\?)*)/g
    : /(?:^|[\s"'`(（「:：,，=])(\/(?:[\w.@%+~-]+\/?)+)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]!.replace(/[.,;:。，；：)）」]+$/u, "");
    if (raw.length > 1) found.push(raw);
    if (found.length >= MAX_REFERENCES) break;
  }
  return found;
}

/**
 * A remote root is "dedicated" when it is neither a filesystem root, a home directory, nor a system
 * directory, so binding it read-only cannot expose a user's personal home (e.g. `~/.ssh`).
 */
export function isDedicatedRemoteRoot(input: { isLocal: boolean; rootDir: string | undefined }): boolean {
  if (input.isLocal || !input.rootDir?.trim()) return false;
  const api = pathApiFor(input.rootDir);
  const root = api.resolve(input.rootDir);
  const parts = root.split(/[\\/]+/).filter(Boolean);
  if (api === path.win32) {
    // `C:\`, `C:\Users`, `C:\Users\<name>`, `C:\Windows…` are never dedicated workspaces.
    const rest = parts.slice(1).map((part) => part.toLowerCase());
    if (rest.length === 0 || rest[0] === "windows" || (rest[0] === "users" && rest.length <= 2)) return false;
    return true;
  }
  if (parts.length === 0) return false;
  const first = parts[0]!;
  if (["etc", "usr", "bin", "sbin", "lib", "lib64", "proc", "sys", "dev", "boot", "var", "root", "tmp", "private", "System", "Library"].includes(first)) {
    return false;
  }
  if ((first === "home" || first === "Users") && parts.length <= 2) return false;
  return true;
}

function deepestCommonDir(api: typeof path.posix | typeof path.win32, dirs: readonly string[]): string | undefined {
  if (!dirs.length) return undefined;
  const split = dirs.map((dir) => api.resolve(dir).split(api.sep));
  const first = split[0]!;
  let length = first.length;
  for (const parts of split.slice(1)) {
    let index = 0;
    while (index < length && index < parts.length && (api === path.win32 ? parts[index]!.toLowerCase() === first[index]!.toLowerCase() : parts[index] === first[index])) index++;
    length = index;
  }
  const joined = first.slice(0, length).join(api.sep);
  return joined || api.sep;
}

/** Resolve where an unbound read-only ticket should run; `default` keeps the isolated `table/` directory. */
export function inferDispatchWorkspace(input: DispatchWorkspaceInferenceInput): DispatchWorkspaceInference {
  if (!input.isReadOnly || !input.envRootDir?.trim()) return { kind: "default" };
  const api = pathApiFor(input.envRootDir);
  const root = api.resolve(input.envRootDir);
  // Without filesystem access a reference is only known to be a directory when it ends with a separator;
  // anything else (files, extensionless names) contributes its parent, which stays read-only and in-root.
  const referenced = [
    ...input.texts.flatMap((text) => (text ? extractAbsolutePaths(text, api) : [])),
    ...(input.coordinatorReadPaths ?? []).filter((candidate) => api.isAbsolute(candidate) && !/[\\/]$/.test(candidate)),
  ].slice(0, MAX_REFERENCES);
  const dirs = referenced
    .map((candidate) => (/[\\/]$/.test(candidate) ? api.resolve(candidate) : api.dirname(api.resolve(candidate))))
    .filter((candidate) => isInside(api, root, candidate));
  const common = deepestCommonDir(api, dirs);
  if (common && isInside(api, root, common)) return { kind: "inferred", dir: common };
  if (input.isRemoteDedicatedRoot) return { kind: "env_root_readonly", dir: root };
  return { kind: "default" };
}
