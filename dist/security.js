import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
const ENCRYPTION_PREFIX = 'enc:v1:';
const WARNINGS = new Set();
const SCOPE_KEYS = {
    config: ['KAPA_VAULT_KEY', 'KAPA_CONFIG_SECRET'],
    history: ['KAPA_HISTORY_KEY', 'KAPA_VAULT_KEY', 'KAPA_CONFIG_SECRET'],
};
const ALLOW_PLAINTEXT_ENV = {
    config: 'KAPA_ALLOW_PLAINTEXT_CONFIG',
    history: 'KAPA_ALLOW_PLAINTEXT_HISTORY',
};
export function isEncryptedValue(value) {
    return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}
export function maskSecret(value) {
    if (!value)
        return '(unset)';
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
}
export function hasSecureKey(scope) {
    return Boolean(getScopeKey(scope));
}
export function allowPlaintext(scope) {
    return process.env[ALLOW_PLAINTEXT_ENV[scope]] === '1';
}
export function encodeSecret(value, scope) {
    if (!value)
        return '';
    const key = getScopeKey(scope);
    if (key) {
        return encryptWithKey(value, key);
    }
    if (allowPlaintext(scope)) {
        warnOnce(`${scope}-plaintext`, buildPlaintextWarning(scope));
        return value;
    }
    throw new Error(`Secure ${scope} storage requires ${formatKeyHint(scope)}. ` +
        `Set the env var or explicitly acknowledge plaintext storage via ${ALLOW_PLAINTEXT_ENV[scope]}=1.`);
}
export function decodeSecret(value, scope) {
    if (!value)
        return '';
    if (!isEncryptedValue(value))
        return value;
    const key = getScopeKey(scope);
    if (!key) {
        warnOnce(`${scope}-decode-missing-key`, `Encrypted ${scope} data exists but ${formatKeyHint(scope)} is not set. Value will be ignored.`);
        return '';
    }
    try {
        return decryptWithKey(value, key);
    }
    catch {
        warnOnce(`${scope}-decode-failed`, `Unable to decrypt ${scope} data. Value will be ignored.`);
        return '';
    }
}
export function tryDecodeSecret(value, scope) {
    if (!isEncryptedValue(value))
        return value;
    const key = getScopeKey(scope);
    if (!key)
        return null;
    try {
        return decryptWithKey(value, key);
    }
    catch {
        return null;
    }
}
function encryptWithKey(value, password) {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = [salt, iv, encrypted, tag].map((buf) => buf.toString('base64')).join('.');
    return `${ENCRYPTION_PREFIX}${payload}`;
}
function decryptWithKey(value, password) {
    const encoded = value.slice(ENCRYPTION_PREFIX.length);
    const [saltB64, ivB64, cipherB64, tagB64] = encoded.split('.');
    if (!saltB64 || !ivB64 || !cipherB64 || !tagB64) {
        throw new Error('Malformed encrypted payload');
    }
    const salt = Buffer.from(saltB64, 'base64');
    const key = scryptSync(password, salt, 32);
    const iv = Buffer.from(ivB64, 'base64');
    const ciphertext = Buffer.from(cipherB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}
function getScopeKey(scope) {
    for (const envName of SCOPE_KEYS[scope]) {
        const value = process.env[envName];
        if (value && value.trim().length) {
            return value;
        }
    }
    return null;
}
function formatKeyHint(scope) {
    if (scope === 'config') {
        return 'KAPA_VAULT_KEY (preferred) or KAPA_CONFIG_SECRET';
    }
    return 'KAPA_HISTORY_KEY (preferred) or KAPA_VAULT_KEY';
}
function buildPlaintextWarning(scope) {
    if (scope === 'config') {
        return ('Plaintext config storage is enabled. Your API key will be written to disk without encryption.');
    }
    return ('Plaintext history storage is enabled. Prompts and answers will be written to disk without encryption.');
}
function warnOnce(key, message) {
    if (WARNINGS.has(key))
        return;
    WARNINGS.add(key);
    process.stderr.write(`[kapa] ${message}\n`);
}
