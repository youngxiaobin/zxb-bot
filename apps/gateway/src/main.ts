import { loadConfig, loadDotEnv, startGateway } from "./index.js";

const [major, minor] = process.versions.node
  .split(".")
  .map((part) => Number(part));
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`需要 Node.js >= 22.18，当前 ${process.version}\n`);
  process.exit(1);
}

process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGSMITH_TRACING = "false";
loadDotEnv();

const config = loadConfig();
let gateway: Awaited<ReturnType<typeof startGateway>>;
try {
  gateway = await startGateway(config);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "网关启动失败"}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ msg: "gateway listening", url: gateway.baseUrl })}\n`,
);

const shutdown = async () => {
  await gateway.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
