import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createReleaseManifest, readReleaseManifest, RecoveryError, verifyRelease } from "@kulo/recovery";

function fail(message: string): never { throw new RecoveryError("customization_payload_invalid", message); }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
function owned(stat: { uid: number }): boolean { return typeof process.getuid !== "function" || stat.uid === process.getuid(); }

async function directory(root: string, candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || !inside(root, path.resolve(candidate))) fail("界面制品目录必须位于本次候选工作区。");
  const relative = path.relative(root, path.resolve(candidate));
  let current = root;
  for (const part of ["", ...(relative ? relative.split(path.sep) : [])]) {
    current = part ? path.join(current, part) : current;
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) fail("界面制品路径包含不支持的目录或链接。");
    if (!inside(root, await fs.realpath(current))) fail("界面制品目录超出候选工作区。");
  }
  return current;
}

async function validateWebTree(root: string): Promise<void> {
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name), stat = await fs.lstat(filename);
      if (!owned(stat)) fail("界面制品包含不属于当前用户的文件。");
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(filename);
        if (path.isAbsolute(target) || !inside(root, await fs.realpath(filename))) fail("界面制品链接指向构建目录外部。");
      } else if (stat.isDirectory()) await walk(filename);
      else if (!stat.isFile() || stat.nlink !== 1) fail("界面制品包含不支持的文件或硬链接。");
    }
  };
  await walk(root);
}

/** Only directories change mode; verified backend file bytes and executable bits stay intact. */
async function writableDirectories(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) fail("候选制品目录不可用。");
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await writableDirectories(path.join(root, entry.name));
  }
}

/** Stable, sandboxed packager: candidate build scripts never prepare the runtime payload. */
export async function prepareWebCustomizationPayload(outputRoot: string, options: {
  workRoot: string; sourceRoot: string; basePayloadRoot: string; baseReleaseId: string;
}): Promise<void> {
  if (!path.isAbsolute(options.workRoot) || !path.isAbsolute(options.basePayloadRoot) || !/^release_[a-f0-9]{24}$/.test(options.baseReleaseId)) fail("定制基线身份或工作目录无效。");
  const rootStat = await fs.lstat(options.workRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !owned(rootStat)) fail("候选工作目录不可用。");
  const workRoot = await fs.realpath(options.workRoot);
  const sourceRoot = await directory(workRoot, options.sourceRoot);
  const webRoot = await directory(workRoot, path.join(sourceRoot, "packages/web/dist"));
  const parent = await directory(workRoot, path.dirname(outputRoot));
  if (!path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== path.join(parent, path.basename(outputRoot)) ||
      outputRoot === workRoot || inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot)) fail("候选制品与源码目录不能重叠。");
  const baseStat = await fs.lstat(options.basePayloadRoot);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) fail("定制基线制品目录无效。");
  const baseRoot = await fs.realpath(options.basePayloadRoot);
  if (inside(workRoot, baseRoot) || inside(baseRoot, workRoot)) fail("定制基线不能与候选工作目录重叠。");
  const manifest = readReleaseManifest(baseRoot);
  if (manifest.id !== options.baseReleaseId || manifest.webDir !== "web/dist") fail("定制基线身份或界面布局与请求不一致。");
  await verifyRelease(baseRoot, manifest, { full: true });
  await validateWebTree(webRoot);
  try {
    const stat = await fs.lstat(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (await fs.readdir(outputRoot)).length) fail("候选制品输出目录必须为空。");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let copied = false;
  try {
    copied = true;
    await fs.cp(baseRoot, outputRoot, { recursive: true, dereference: false, verbatimSymlinks: true,
      force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
    await verifyRelease(outputRoot, manifest, { full: true });
    await writableDirectories(outputRoot);
    for (const filename of ["kulo-release.json", "kulo-release.identity.json", "kulo-source.json", "kulo-source.json.gz"]) {
      await fs.rm(path.join(outputRoot, filename), { force: true });
    }
    const outputWeb = await directory(outputRoot, path.join(outputRoot, "web"));
    await fs.rm(path.join(outputWeb, "dist"), { recursive: true, force: true });
    await fs.cp(webRoot, path.join(outputWeb, "dist"), { recursive: true, dereference: false, verbatimSymlinks: true,
      force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
    const candidate = await createReleaseManifest(outputRoot, { version: manifest.version, kind: "custom", shellVersion: manifest.shellVersion,
      platform: manifest.platform, arch: manifest.arch, nodeMajor: manifest.nodeMajor, protocolVersion: manifest.protocolVersion,
      dataVersion: manifest.dataVersion, minDataVersion: manifest.minDataVersion, maxDataVersion: manifest.maxDataVersion,
      runtimeEntry: manifest.runtimeEntry, webDir: manifest.webDir, baseReleaseId: manifest.id });
    await verifyRelease(outputRoot, candidate, { full: true });
  } catch (error) {
    if (copied && await fs.lstat(outputRoot).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return undefined; throw cause; })) {
      await writableDirectories(outputRoot); await fs.rm(outputRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
