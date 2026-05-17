import { describe, it, expect } from "vitest";
import {
  MemoryStorageAdapter,
  createStorageGateway,
} from "../src/storage/gateway";
import { DEFAULT_SETTINGS } from "../src/shared/types/settings";
import type { ProfileKey } from "../src/shared/types/profile";

describe("storage gateway (memory adapter)", () => {
  it("returns defaults when nothing is stored", async () => {
    const gw = createStorageGateway(new MemoryStorageAdapter());
    const settings = await gw.loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    const profile = await gw.loadProfile("http://x" as ProfileKey);
    expect(profile.sessions).toEqual([]);
    expect(profile.activeSessionId).toBeNull();
  });

  it("persists and reloads settings", async () => {
    const adapter = new MemoryStorageAdapter();
    const gw = createStorageGateway(adapter);
    await gw.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-test" });
    const loaded = await gw.loadSettings();
    expect(loaded.apiKey).toBe("sk-test");
  });

  it("namespaces profiles by key", async () => {
    const adapter = new MemoryStorageAdapter();
    const gw = createStorageGateway(adapter);
    await gw.saveProfile("http://a" as ProfileKey, {
      sessions: [
        {
          id: "s1",
          profileKey: "http://a" as ProfileKey,
          title: "t",
          createdAt: 1,
          updatedAt: 1,
          modelId: "m",
          messages: [],
        },
      ],
      activeSessionId: "s1",
      lastModelId: "m",
    });
    await gw.saveProfile("http://b" as ProfileKey, {
      sessions: [],
      activeSessionId: null,
      lastModelId: null,
    });
    const a = await gw.loadProfile("http://a" as ProfileKey);
    const b = await gw.loadProfile("http://b" as ProfileKey);
    expect(a.sessions).toHaveLength(1);
    expect(b.sessions).toHaveLength(0);
  });
});
