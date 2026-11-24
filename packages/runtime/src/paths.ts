import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class PathRejected extends Error {
  readonly code = "PATH_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "PathRejected";
  }
}

export class NoteWriteUncertain extends Error {
  constructor(cause: unknown) {
    super("笔记文件已创建，但无法确认内容是否完整写入。", { cause });
    this.name = "NoteWriteUncertain";
  }
}

function assertContained(rootReal: string, candidate: string): string {
  const real = fs.realpathSync(candidate);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (real !== rootReal && !real.startsWith(prefix)) {
    throw new PathRejected("路径越出了允许的目录。");
  }
  return real;
}

export function listFixtures(fixturesDir: string): string[] {
  const root = fs.realpathSync(fixturesDir);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new PathRejected("资料目录不能是符号链接。");
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export function readFixture(
  fixturesDir: string,
  name: string,
): { path: string; sha256: string; text: string } {
  if (typeof name !== "string" || name.length === 0 || name.length > 180) {
    throw new PathRejected("文件名不合法。");
  }
  if (
    name !== path.basename(name) ||
    name.includes("..") ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new PathRejected("只允许读取资料目录中的文件名，拒绝路径穿越。");
  }
  const root = fs.realpathSync(fixturesDir);
  const candidate = path.resolve(root, name);
  const listed = fs.lstatSync(candidate);
  if (listed.isSymbolicLink() || !listed.isFile())
    throw new PathRejected("拒绝符号链接或非普通文件。");
  const real = assertContained(root, candidate);
  const text = fs.readFileSync(real, "utf8");
  return {
    path: `fixtures/${name}`,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
  };
}

export function writeDemoNote(
  dataDir: string,
  runId: string,
  body: string,
): { path: string; bytes: number } {
  if (!/^[0-9a-f-]{36}$/.test(runId))
    throw new PathRejected("运行编号不能作为文件名。");
  const notes = path.resolve(dataDir, "sandbox", "notes");
  fs.mkdirSync(notes, { recursive: true });
  const root = fs.realpathSync(notes);
  if (fs.lstatSync(root).isSymbolicLink())
    throw new PathRejected("写入目录不能是符号链接。");
  const fileName = `${runId}.md`;
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new PathRejected("写入路径越界。");
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new PathRejected("拒绝覆盖符号链接。");
  }
  const fd = fs.openSync(target, "wx");
  try {
    try {
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new NoteWriteUncertain(error);
  }
  return { path: `sandbox/notes/${fileName}`, bytes: Buffer.byteLength(body) };
}
