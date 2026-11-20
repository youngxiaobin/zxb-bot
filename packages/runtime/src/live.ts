import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

export let liveCompletionCount = 0;

const listTool = tool(async () => "listed-by-runtime", {
  name: "list_fixtures",
  description: "列出只读资料文件名。实际读取由运行时账本执行。",
  schema: z.object({}).strict(),
});

const readTool = tool(async ({ name }: { name: string }) => name, {
  name: "read_fixture",
  description: "按文件名读取只读资料。禁止路径穿越。",
  schema: z.object({ name: z.string() }).strict(),
});

const delegateTool = tool(async ({ goal }: { goal: string }) => goal, {
  name: "delegate_specialists",
  description:
    "请两名只读专员分别研究资料和整理提纲。专员不能再委托，也不能写入。",
  schema: z.object({ goal: z.string() }).strict(),
});

const writeTool = tool(
  async ({ title, body }: { title: string; body: string }) =>
    `${title}\n${body}`,
  {
    name: "write_demo_note",
    description: "把摘要写入 sandbox。运行时会在真正写入前中断并等待人工批准。",
    schema: z.object({ title: z.string(), body: z.string() }).strict(),
  },
);

export async function completeLive(input: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  timeoutMs: number;
}): Promise<{
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}> {
  if (!input.apiKey) {
    throw Object.assign(new Error("未配置实况模型"), {
      code: "PROVIDER_NOT_CONFIGURED",
    });
  }
  liveCompletionCount += 1;
  const model = new ChatOpenAI({
    model: input.model,
    apiKey: input.apiKey,
    timeout: input.timeoutMs,
    temperature: 0,
    configuration: input.baseUrl ? { baseURL: input.baseUrl } : undefined,
  });
  const bound = model.bindTools([listTool, readTool, delegateTool, writeTool]);
  const response = await bound.invoke(input.messages);
  const text =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  const toolCalls = (response.tool_calls ?? []).map((call) => ({
    name: call.name,
    args: (call.args ?? {}) as Record<string, unknown>,
  }));
  return { text, toolCalls };
}
