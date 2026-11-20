const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, "../..");

config.watchFolders = [root];
config.resolver.unstable_enablePackageExports = true;
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(root, "node_modules"),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const base = moduleName.slice(0, -3);
    for (const extension of [".ts", ".tsx"]) {
      try {
        return context.resolveRequest(context, `${base}${extension}`, platform);
      } catch {
        // 源码用 .js 后缀指向相邻的 TypeScript 文件，两种扩展名都试一次。
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
