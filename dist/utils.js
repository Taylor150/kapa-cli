import { stdin as input } from 'process';
export async function readFromStdin(force = false) {
    if (!force && input.isTTY) {
        return '';
    }
    const chunks = [];
    return new Promise((resolve, reject) => {
        input.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        input.on('error', reject);
        input.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8').trim());
        });
    });
}
export function parseMetadata(pairs = []) {
    const result = {};
    for (const pair of pairs) {
        const [key, ...rest] = pair.split('=');
        if (!key || !rest.length)
            continue;
        const value = rest.join('=');
        const lower = value.toLowerCase();
        if (['true', 'false'].includes(lower)) {
            result[key] = lower === 'true';
        }
        else if (!Number.isNaN(Number(value))) {
            result[key] = Number(value);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
export function wrapText(text, width = 100) {
    if (!text)
        return '';
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
        if ((current + word).length > width) {
            lines.push(current.trimEnd());
            current = '';
        }
        current += `${word} `;
    }
    if (current.trim().length) {
        lines.push(current.trimEnd());
    }
    return lines.join('\n');
}
export function timestamp() {
    return new Date().toISOString();
}
export function extractCodeBlocks(text) {
    const blocks = [];
    const lines = text.split(/\r?\n/);
    let current = [];
    for (const line of lines) {
        if (line.trim().length && line.startsWith('    ')) {
            current.push(line.trimStart());
        }
        else if (current.length) {
            blocks.push(current.join('\n'));
            current = [];
        }
    }
    if (current.length) {
        blocks.push(current.join('\n'));
    }
    return blocks;
}
