import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

const Settings = z.object({
  baseUrl: z.string().url(),
  code: z.string().min(4),
  deviceLabel: z.string().min(1).max(80),
});

contextBridge.exposeInMainWorld("personalAgent", {
  getSnapshot: () => ipcRenderer.invoke("pa:getSnapshot"),
  subscribe: (callback: (projection: unknown) => void) => {
    const listener = (_event: unknown, projection: unknown) =>
      callback(projection);
    ipcRenderer.on("pa:snapshot", listener);
    return () => ipcRenderer.removeListener("pa:snapshot", listener);
  },
  command: (input: unknown) => ipcRenderer.invoke("pa:command", input),
  mint: (baseUrl: string) =>
    ipcRenderer.invoke("pa:mint", z.string().url().parse(baseUrl)),
  redeem: (input: unknown) =>
    ipcRenderer.invoke("pa:redeem", Settings.parse(input)),
  adopt: (input: unknown) => {
    const record = input as { baseUrl?: unknown; token?: unknown };
    const baseUrl = z.string().url().parse(record.baseUrl);
    if (typeof record.token !== "string" || record.token.trim().length < 8) {
      throw new Error("设备令牌格式不正确。");
    }
    return ipcRenderer.invoke("pa:adopt", {
      baseUrl,
      token: record.token.trim(),
    });
  },
  forget: () => ipcRenderer.invoke("pa:forget"),
});
