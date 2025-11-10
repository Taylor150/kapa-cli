import { fetch } from 'undici';
const DEFAULT_BASE_URL = 'https://api.kapa.ai/query/v1';
function stripTrailingSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}
function buildEndpoint(baseUrl, projectId, threadId) {
    const root = stripTrailingSlash(baseUrl || DEFAULT_BASE_URL);
    if (threadId) {
        return `${root}/threads/${threadId}/chat/`;
    }
    if (!projectId) {
        throw new Error('A project id is required to start a new conversation.');
    }
    return `${root}/projects/${projectId}/chat/`;
}
function buildPayload(options) {
    const payload = {
        integration_id: options.integrationId,
        query: options.prompt,
    };
    if (options.metadata && Object.keys(options.metadata).length) {
        payload.metadata = options.metadata;
    }
    if (options.userIdentifier) {
        payload.user_identifier = options.userIdentifier;
    }
    if (typeof options.temperature === 'number') {
        payload.temperature = options.temperature;
    }
    if (options.additionalFields) {
        Object.assign(payload, options.additionalFields);
    }
    return payload;
}
function parseSseChunk(chunk) {
    const event = { type: 'message' };
    const lines = chunk.split('\n');
    for (const line of lines) {
        if (line.startsWith('event:')) {
            event.type = line.slice(6).trim();
        }
        else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            event.payload = event.payload ? `${event.payload}${data}` : data;
        }
    }
    return event;
}
function extractText(payload) {
    if (!payload)
        return '';
    const candidates = [
        payload.delta,
        payload.answer_delta,
        payload.answerChunk,
        payload.answer_chunk,
        payload.content_delta,
        payload.text,
        payload.message,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.length)
            return value;
    }
    if (Array.isArray(payload.choices)) {
        return payload.choices.map((choice) => choice.delta || choice.text || '').join('');
    }
    return '';
}
async function consumeSse(body, handler) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastPayload = null;
    let combinedText = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseSseChunk(chunk);
            if (event.payload === '[DONE]') {
                handler?.({ type: 'done' });
                return (lastPayload || {
                    answer: combinedText,
                });
            }
            let parsedPayload;
            if (typeof event.payload === 'string') {
                try {
                    parsedPayload = JSON.parse(event.payload);
                }
                catch {
                    parsedPayload = event.payload;
                }
            }
            else {
                parsedPayload = event.payload;
            }
            lastPayload = typeof parsedPayload === 'object' ? parsedPayload : lastPayload;
            const text = extractText(parsedPayload);
            if (text) {
                combinedText += text;
            }
            handler?.({
                type: event.type,
                payload: parsedPayload,
                text,
            });
        }
    }
    if (lastPayload && combinedText && !lastPayload.answer) {
        lastPayload.answer = combinedText;
    }
    return lastPayload || { answer: combinedText };
}
export async function sendChat(options) {
    if (!options.apiKey) {
        throw new Error('Missing KAPA API key.');
    }
    if (!options.integrationId) {
        throw new Error('Missing integration id.');
    }
    const endpoint = buildEndpoint(options.baseUrl || DEFAULT_BASE_URL, options.projectId, options.threadId);
    const payload = buildPayload(options);
    const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': options.apiKey,
        },
        signal: options.signal,
    });
    if (!response.ok) {
        const text = await response.text();
        const snippet = text.length > 500 ? `${text.slice(0, 497)}…` : text;
        throw new Error(`Kapa API error ${response.status}: ${snippet}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (options.stream && contentType.includes('text/event-stream')) {
        const streamed = await consumeSse(response.body, options.onStreamEvent);
        return { streamed: true, data: streamed };
    }
    const data = await response.json().catch(async () => {
        const text = await response.text();
        throw new Error(`Unexpected response payload: ${text.slice(0, 400)}`);
    });
    return { streamed: false, data };
}
