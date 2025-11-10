import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const configRoot = await mkdtemp(path.join(os.tmpdir(), 'kapa-config-test-'));
process.env.KAPA_CONFIG_DIR = configRoot;
process.env.KAPA_VAULT_KEY = 'unit-test-secret';
delete process.env.KAPA_ALLOW_PLAINTEXT_CONFIG;

const configModule = await import('./config.js');
const { setConfigValue, loadConfig, getConfigPath } = configModule;

async function resetConfig() {
  await rm(getConfigPath(), { force: true });
}

test('API keys are encrypted on disk and decrypted at runtime', async () => {
  await resetConfig();
  const result = await setConfigValue('apiKey', 'sk-unit');
  assert.equal(result.value, 'sk…it');

  const loaded = await loadConfig();
  assert.equal(loaded.profiles.default.apiKey, 'sk-unit');

  const raw = await readFile(getConfigPath(), 'utf8');
  assert.ok(raw.includes('enc:v1:'), 'stored config should contain encrypted payload');
});

test('non-sensitive values persist without encryption', async () => {
  await resetConfig();
  await setConfigValue('projectId', 'proj_123');
  const loaded = await loadConfig();
  assert.equal(loaded.profiles.default.projectId, 'proj_123');

  const raw = await readFile(getConfigPath(), 'utf8');
  assert.ok(raw.includes('proj_123'));
});
