import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { decodeSecret, encodeSecret, maskSecret } from './security.js';

export interface ProfileConfig {
  apiKey?: string;
  projectId?: string;
  integrationId?: string;
  baseUrl?: string;
  stream?: boolean;
  temperature?: number | null;
}

export interface CliConfig {
  defaultProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface ResolvedProfile {
  name: string;
  values: Required<ProfileConfig>;
}

interface RawCliConfig {
  defaultProfile?: string;
  profiles?: Record<string, ProfileConfig>;
}

const CONFIG_DIR =
  process.env.KAPA_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'kapa-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_PROFILE: Required<ProfileConfig> = {
  apiKey: '',
  projectId: '',
  integrationId: '',
  baseUrl: 'https://api.kapa.ai/query/v1',
  stream: true,
  temperature: null,
};

const DEFAULT_CONFIG: CliConfig = {
  defaultProfile: 'default',
  profiles: {
    default: {},
  },
};

const BOOLEAN_KEYS = new Set(['stream']);
const NUMBER_KEYS = new Set(['temperature']);
const SENSITIVE_KEY: keyof ProfileConfig = 'apiKey';

function mergeProfile(profile: ProfileConfig = {}): Required<ProfileConfig> {
  return { ...DEFAULT_PROFILE, ...profile };
}

function normalizeKey(key: string): keyof ProfileConfig | 'defaultProfile' {
  const clean = key.toLowerCase();
  if (['api-key', 'apikey', 'key'].includes(clean)) return 'apiKey';
  if (['project', 'project-id', 'projectid'].includes(clean)) return 'projectId';
  if (['integration', 'integration-id', 'integrationid'].includes(clean)) {
    return 'integrationId';
  }
  if (['baseurl', 'base-url', 'url'].includes(clean)) return 'baseUrl';
  if (['stream', 'no-stream'].includes(clean)) return 'stream';
  if (['temperature', 'temp'].includes(clean)) return 'temperature';
  if (['default', 'default-profile'].includes(clean)) return 'defaultProfile';
  return key as keyof ProfileConfig;
}

function parseValue(key: keyof ProfileConfig, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return value;
}

async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<CliConfig> {
  const raw = await readRawConfig();
  const mergedProfiles: Record<string, Required<ProfileConfig>> = {};
  const combinedProfiles = { ...DEFAULT_CONFIG.profiles, ...(raw.profiles ?? {}) };
  for (const [name, profile] of Object.entries(combinedProfiles)) {
    mergedProfiles[name] = mergeProfile(decodeProfile(profile));
  }
  return {
    defaultProfile: raw.defaultProfile ?? DEFAULT_CONFIG.defaultProfile,
    profiles: mergedProfiles,
  };
}

export async function saveConfig(config: CliConfig): Promise<void> {
  const serialised: RawCliConfig = {
    defaultProfile: config.defaultProfile,
    profiles: {},
  };
  for (const [name, profile] of Object.entries(config.profiles)) {
    serialised.profiles![name] = encodeProfile(profile);
  }
  await writeRawConfig(serialised);
}

export function getConfigPath() {
  return CONFIG_PATH;
}

export function getConfigDirectory() {
  return CONFIG_DIR;
}

export function resolveProfile(config: CliConfig, profileName?: string): ResolvedProfile {
  const name = profileName ?? config.defaultProfile ?? 'default';
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Profile "${name}" not found. Use "kapa config profile create ${name}" first.`);
  }
  return {
    name,
    values: mergeProfile(profile),
  };
}

export async function setConfigValue(
  key: string,
  value: string,
  options: { profile?: string } = {},
) {
  const normalized = normalizeKey(key);
  const config = await readRawConfig();
  if (normalized === 'defaultProfile') {
    config.defaultProfile = value;
    config.profiles = config.profiles ?? {};
    if (!config.profiles[value]) {
      config.profiles[value] = {};
    }
    await writeRawConfig(config);
    return { key: normalized, value };
  }

  const profileName = options.profile ?? config.defaultProfile ?? 'default';
  config.profiles = config.profiles ?? {};
  if (!config.profiles[profileName]) {
    config.profiles[profileName] = {};
  }

  const profileKey = normalized as keyof ProfileConfig;
  const parsed = parseValue(profileKey, value);
  const targetProfile = config.profiles[profileName] as Record<string, unknown>;
  if (isSensitiveKey(profileKey)) {
    const stored = typeof parsed === 'string' ? parsed : String(parsed ?? '');
    targetProfile[profileKey] = stored ? encodeSecret(stored, 'config') : '';
    await writeRawConfig(config);
    return { key: normalized, value: maskSecret(stored), profile: profileName };
  }
  targetProfile[profileKey] = parsed as unknown;
  await writeRawConfig(config);

  return { key: normalized, value: parsed, profile: profileName };
}

export async function createProfile(name: string) {
  const config = await readRawConfig();
  config.profiles = config.profiles ?? {};
  if (config.profiles[name]) {
    throw new Error(`Profile "${name}" already exists.`);
  }
  config.profiles[name] = {};
  await writeRawConfig(config);
  return name;
}

export async function deleteProfile(name: string) {
  const config = await readRawConfig();
  config.profiles = config.profiles ?? {};
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  if (!name || name === (config.defaultProfile ?? DEFAULT_CONFIG.defaultProfile)) {
    throw new Error('Cannot delete the default profile. Switch profiles first.');
  }
  delete config.profiles[name];
  await writeRawConfig(config);
}

export async function listProfiles() {
  const config = await loadConfig();
  return {
    defaultProfile: config.defaultProfile,
    profiles: config.profiles,
  };
}

export function summarizeProfile(profile: ProfileConfig) {
  const merged = mergeProfile(profile);
  return {
    apiKey: merged.apiKey ? maskSecret(merged.apiKey) : '(unset)',
    projectId: merged.projectId || '(unset)',
    integrationId: merged.integrationId || '(unset)',
    baseUrl: merged.baseUrl,
    stream: merged.stream,
    temperature: merged.temperature,
  };
}

export function normalizeConfigKey(key: string) {
  return normalizeKey(key);
}

async function readRawConfig(): Promise<RawCliConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as RawCliConfig;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        defaultProfile: DEFAULT_CONFIG.defaultProfile,
        profiles: { ...DEFAULT_CONFIG.profiles },
      };
    }
    throw error;
  }
}

async function writeRawConfig(config: RawCliConfig) {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function decodeProfile(profile: ProfileConfig = {}) {
  const copy: ProfileConfig = { ...profile };
  if (typeof copy.apiKey === 'string') {
    copy.apiKey = decodeSecret(copy.apiKey, 'config');
  }
  return copy;
}

function encodeProfile(profile: ProfileConfig = {}) {
  const copy: ProfileConfig = { ...profile };
  if (typeof copy.apiKey === 'string' && copy.apiKey.length) {
    copy.apiKey = encodeSecret(copy.apiKey, 'config');
  }
  return copy;
}

function isSensitiveKey(key: keyof ProfileConfig) {
  return key === SENSITIVE_KEY;
}
