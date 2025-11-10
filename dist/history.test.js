import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
const historyRoot = await mkdtemp(path.join(os.tmpdir(), 'kapa-history-test-'));
process.env.KAPA_DATA_DIR = historyRoot;
process.env.KAPA_HISTORY_KEY = 'unit-history-secret';
delete process.env.KAPA_ALLOW_PLAINTEXT_HISTORY;
const historyModule = await import('./history.js');
const { appendHistory, readHistory, clearHistory } = historyModule;
test('history entries are encrypted and returned newest-first', async () => {
    await clearHistory();
    await appendHistory({
        timestamp: '2024-01-01T00:00:00Z',
        profile: 'default',
        prompt: 'first',
        response: 'one',
        threadId: 't1',
    });
    await appendHistory({
        timestamp: '2024-01-02T00:00:00Z',
        profile: 'default',
        prompt: 'second',
        response: 'two',
        threadId: 't2',
    });
    const entries = await readHistory(5);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].threadId, 't2');
    assert.equal(entries[1].threadId, 't1');
    await clearHistory();
    const after = await readHistory();
    assert.equal(after.length, 0);
});
