export {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
  type AgentSocket,
  type CredentialStore,
  type HttpTransport,
  type ProjectionPersistence,
  type SocketFactory,
} from "./client.js";
export {
  emptyProjection,
  type ConnectionState,
  type Projection,
} from "./projection.js";
export { parseMarkdown, markdownToPlain } from "./markdown.js";
export type { MarkdownBlock, MarkdownSpan } from "./markdown.js";
export { applyEvent, applySnapshot } from "./reduce.js";
export { validateGatewayUrl } from "./url.js";
