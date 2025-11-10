import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { encodeSecret, decodeSecret, isEncryptedValue } from './security.js';

export interface HistoryEntry {
  timestamp: string;
  profile: string;
  prompt: string;
  response: string;
  threadId?: string;
  questionAnswerId?: string;
  metadata?: Record<string, unknown>;
}

const HISTORY_DIR =
  process.env.KAPA_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'kapa-cli');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.jsonl');

let historyDisabledMessage: string | null = null;

async function ensureHistoryDir() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

export function getHistoryPath() {
  return HISTORY_PATH;
}

export async function appendHistory(entry: HistoryEntry) {
  if (historyDisabledMessage) {
    return;
  }
  await ensureHistoryDir();
  const serialized = JSON.stringify(entry);
  try {
    const payload = `${encodeSecret(serialized, 'history')}\n`;
    await fs.appendFile(HISTORY_PATH, payload, 'utf8');
  } catch (error: any) {
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
        if (!decoded) return null;
        try {
          return JSON.parse(decoded) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as HistoryEntry[];
    return items.slice(-limit).reverse();
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function clearHistory() {
  try {
    await fs.unlink(HISTORY_PATH);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function getLastThread(profile: string) {
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

function decodeHistoryLine(line: string) {
  if (!line) return null;
  if (!isEncryptedValue(line)) {
    return line;
  }
  const decoded = decodeSecret(line, 'history');
  return decoded || null;
}
