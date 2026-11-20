import * as SecureStore from "expo-secure-store";
import type {
  CredentialStore,
  Projection,
  ProjectionPersistence,
} from "@pa/sdk";

const CREDENTIALS = "pa.credentials";
const PROJECTION = "pa.projection";

export const secureCredentials: CredentialStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(CREDENTIALS);
    return raw
      ? (JSON.parse(raw) as {
          baseUrl: string;
          token: string;
          deviceId: string;
          userId: string;
        })
      : null;
  },
  async save(value) {
    await SecureStore.setItemAsync(CREDENTIALS, JSON.stringify(value));
  },
  async clear() {
    await SecureStore.deleteItemAsync(CREDENTIALS);
  },
};

export const secureProjection: ProjectionPersistence = {
  async load() {
    const raw = await SecureStore.getItemAsync(PROJECTION);
    return raw
      ? (JSON.parse(raw) as {
          version: number;
          cursor: string | null;
          projection: Projection;
        })
      : null;
  },
  async save(value) {
    await SecureStore.setItemAsync(PROJECTION, JSON.stringify(value));
  },
};
