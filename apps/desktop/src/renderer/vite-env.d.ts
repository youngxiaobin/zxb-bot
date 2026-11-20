/// <reference types="vite/client" />

interface PersonalAgentBridge {
  getSnapshot(): Promise<import("@pa/sdk").Projection>;
  subscribe(
    callback: (projection: import("@pa/sdk").Projection) => void,
  ): () => void;
  command(input: unknown): Promise<unknown>;
  mint(baseUrl: string): Promise<{ code: string; expiresAt: string }>;
  redeem(input: {
    baseUrl: string;
    code: string;
    deviceLabel: string;
  }): Promise<void>;
  adopt(input: { baseUrl: string; token: string }): Promise<void>;
  forget(): Promise<void>;
}

interface Window {
  personalAgent?: PersonalAgentBridge;
}
