// Storage gateway (docs/architecture.md §3.7).
//
// The single module that talks to `chrome.storage.local`. All other modules
// call it through the `StorageGateway` interface; nothing else touches
// `chrome.storage` directly. When the `chrome.*` API is unavailable (tests,
// node-only tooling) a memory-backed adapter with identical semantics is used.

import type { ProfileKey } from "../shared/profile";
import type { Session } from "../shared/session";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";

export const STORAGE_SCHEMA_VERSION = 1;

const SETTINGS_KEY = "hermes-sidebar:settings";
const PROFILE_PREFIX = "hermes-sidebar:profile:";

interface PersistedSettingsRecord {
  schemaVersion: number;
  settings: Settings;
}

interface PersistedProfileRecord {
  schemaVersion: number;
  sessions: Session[];
  activeSessionId: string | null;
  lastModelId: string | null;
}

export function profileKey(key: ProfileKey): string {
  return `${PROFILE_PREFIX}${key}`;
}

/**
 * Async key/value adapter. Mirrors the subset of `chrome.storage.local` we use.
 * `get` returns `undefined` for missing keys; `set` overwrites; `remove`
 * deletes.
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory adapter used by tests and non-chrome environments. */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (this.data.get(key) as T) : undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

type ChromeStorageArea = {
  get: (
    keys: string | string[],
    cb: (items: Record<string, unknown>) => void,
  ) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
  remove: (keys: string | string[], cb: () => void) => void;
};

/** Adapter for `chrome.storage.local`. */
export class ChromeStorageAdapter implements StorageAdapter {
  constructor(private readonly area: ChromeStorageArea) {}

  get<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve) =>
      this.area.get(key, (items) => {
        resolve(items[key] as T | undefined);
      }),
    );
  }
  set<T>(key: string, value: T): Promise<void> {
    return new Promise((resolve) =>
      this.area.set({ [key]: value }, () => resolve()),
    );
  }
  remove(key: string): Promise<void> {
    return new Promise((resolve) => this.area.remove(key, () => resolve()));
  }
}

/**
 * Pick the best available adapter. If `chrome.storage.local` is present, use
 * it; otherwise use an in-memory adapter. This lets tests, node tooling, and
 * the extension code share the same gateway.
 */
export function detectAdapter(): StorageAdapter {
  const g = globalThis as {
    chrome?: { storage?: { local?: ChromeStorageArea } };
  };
  const area = g.chrome?.storage?.local;
  if (area && typeof area.get === "function" && typeof area.set === "function") {
    return new ChromeStorageAdapter(area);
  }
  return new MemoryStorageAdapter();
}

export interface ProfileRecord {
  sessions: Session[];
  activeSessionId: string | null;
  lastModelId: string | null;
}

export interface StorageGateway {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  loadProfile(key: ProfileKey): Promise<ProfileRecord>;
  saveProfile(key: ProfileKey, record: ProfileRecord): Promise<void>;
}

export function createStorageGateway(
  adapter: StorageAdapter = detectAdapter(),
): StorageGateway {
  return {
    async loadSettings(): Promise<Settings> {
      const raw = await adapter.get<PersistedSettingsRecord>(SETTINGS_KEY);
      if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
      const merged = { ...DEFAULT_SETTINGS, ...raw.settings };
      if (
        typeof raw.settings.maxDomInputTokens !== "number" ||
        raw.settings.maxDomInputTokens === 30_000
      ) {
        merged.maxDomInputTokens = DEFAULT_SETTINGS.maxDomInputTokens;
      }
      return merged;
    },
    async saveSettings(settings) {
      const rec: PersistedSettingsRecord = {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        settings,
      };
      await adapter.set(SETTINGS_KEY, rec);
    },
    async loadProfile(key) {
      const raw = await adapter.get<PersistedProfileRecord>(profileKey(key));
      if (!raw) {
        return { sessions: [], activeSessionId: null, lastModelId: null };
      }
      return {
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        activeSessionId: raw.activeSessionId ?? null,
        lastModelId: raw.lastModelId ?? null,
      };
    },
    async saveProfile(key, record) {
      const rec: PersistedProfileRecord = {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        sessions: record.sessions,
        activeSessionId: record.activeSessionId,
        lastModelId: record.lastModelId,
      };
      await adapter.set(profileKey(key), rec);
    },
  };
}
