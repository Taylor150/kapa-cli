import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { encodeSecret, decodeSecret, isEncryptedValue } from './security.js';
const HISTORY_DIR = process.env.KAPA_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'kapa-cli');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.jsonl');
let historyDisabledMessage = null;
async function ensureHistoryDir() {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
}
export function getHistoryPath() {
    return HISTORY_PATH;
}
export async function appendHistory(entry) {
    if (historyDisabledMessage) {
        return;
    }
    await ensureHistoryDir();
    const serialized = JSON.stringify(entry);
    try {
        const payload = `${encodeSecret(serialized, 'history')}\n`;
        await fs.appendFile(HISTORY_PATH, payload, 'utf8');
    }
    catch (error) {
        historyDisabledMessage = error?.message ?? 'History storage disabled.';
        process.stderr.write(`[kapa] ${historyDisabledMessage}\n`);
    }
}
export async function readHistory(limit = 10) {
    try {
        const raw = await fs.readFile(HISTORY_PATH, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const items = lines
            .map((line) => {
            const decoded = decodeHistoryLine(line);
            if (!decoded)
                return null;
            try {
                return JSON.parse(decoded);
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
        return items.slice(-limit).reverse();
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
export async function clearHistory() {
    try {
        await fs.unlink(HISTORY_PATH);
    }
    catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}
export async function getLastThread(profile) {
    const history = await readHistory(200);
    for (const entry of history) {
        if (entry.profile === profile && entry.threadId) {
            return entry.threadId;
        }
    }
    return null;
}
export function getHistoryStatus() {
    return {
        disabled: Boolean(historyDisabledMessage),
        reason: historyDisabledMessage,
    };
}
function decodeHistoryLine(line) {
    if (!line)
        return null;
    if (!isEncryptedValue(line)) {
        return line;
    }
    const decoded = decodeSecret(line, 'history');
    return decoded || null;
}
