export function validateGatewayUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Gateway 地址不是有效的 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway 地址只接受 http 或 https。");
  }
  if (url.username || url.password) {
    throw new Error("Gateway 地址不能携带账号。");
  }
  if (url.search || url.hash) {
    throw new Error("Gateway 地址不能携带参数或片段。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "";
  return url.toString().replace(/\/$/, "");
}
