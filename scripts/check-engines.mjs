const [major, minor] = process.versions.node
  .split(".")
  .map((part) => Number(part));
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`需要 Node.js >= 22.18，当前 ${process.version}`);
  process.exit(1);
}

const userAgent = process.env.npm_config_user_agent ?? "";
const fromAgent = /pnpm\/(\d+)\./.exec(userAgent);
let pnpmMajor = fromAgent ? Number(fromAgent[1]) : null;
if (pnpmMajor == null) {
  const { execSync } = await import("node:child_process");
  try {
    const version = execSync("pnpm -v", { encoding: "utf8" }).trim();
    pnpmMajor = Number(version.split(".")[0]);
  } catch {
    console.error("无法检测 pnpm 版本。请使用 pnpm 11。");
    process.exit(1);
  }
}
if (pnpmMajor !== 11) {
  console.error(`需要 pnpm 11，当前主版本 ${pnpmMajor}`);
  process.exit(1);
}

console.log(`engines ok node=${process.version} pnpm=${pnpmMajor}`);
