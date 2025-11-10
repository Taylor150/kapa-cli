import { stdout as stdoutStream } from 'node:process';
import chalk from 'chalk';

export interface NormalizedResponse {
  answer: string;
  citations: Array<Record<string, any>>;
  followUps: Array<string | Record<string, any>>;
  threadId?: string;
  questionAnswerId?: string;
  raw: any;
}

const supportsHyperlinks =
  typeof stdoutStream !== 'undefined' && typeof stdoutStream.isTTY === 'boolean'
    ? stdoutStream.isTTY
    : false;

const hyperlink = (text: string, url?: string) => {
  if (!url) return text;
  if (!supportsHyperlinks) {
    return `${text} ${chalk.underline(`(${url})`)}`;
  }
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
};

export function normalizeResponse(payload: any): NormalizedResponse {
  const qa =
    payload?.question_answer ||
    payload?.questionAnswer ||
    payload?.data?.question_answer ||
    null;

  const answer =
    qa?.answer ||
    qa?.answer_text ||
    payload?.answer ||
    payload?.message ||
    payload?.content ||
    '';

  const citations =
    qa?.citations ||
    payload?.citations ||
    payload?.source_documents ||
    payload?.sources ||
    [];

  const followUps =
    qa?.follow_up_questions ||
    qa?.followUpQuestions ||
    qa?.followup_questions ||
    payload?.followUpQuestions ||
    [];

  const threadId = qa?.thread_id || payload?.thread_id || payload?.threadId;
  const questionAnswerId =
    qa?.id || qa?.question_answer_id || payload?.question_answer_id;

  return {
    answer: answer || '',
    citations: Array.isArray(citations) ? citations : [],
    followUps: Array.isArray(followUps) ? followUps : [],
    threadId,
    questionAnswerId,
    raw: payload,
  };
}

export function renderCitations(citations: Array<Record<string, any>>) {
  if (!citations.length) return '';
  const items = citations.map((citation, idx) => {
    const url =
      citation.url ||
      citation.link ||
      citation.href ||
      citation?.source?.url ||
      citation?.metadata?.url;
    const title = citation.title || citation.name || url || `Source ${idx + 1}`;
    const label = hyperlink(title, url);
    return `  ${idx + 1}. ${label}`;
  });
  return ['References:', ...items].join('\n');
}

export function renderFollowUps(followUps: NormalizedResponse['followUps']) {
  if (!followUps.length) return '';
  const items = followUps.map((item) => {
    if (typeof item === 'string') return `  • ${item}`;
    if (item && typeof item === 'object') {
      return `  • ${item.question || item.prompt || JSON.stringify(item)}`;
    }
    return `  • ${String(item)}`;
  });
  return ['Try next:', ...items].join('\n');
}

export function formatAnswerBlock(answer: string) {
  if (!answer) return '';
  const lines = answer.replace(/\r/g, '').split('\n');
  const formatted: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    const fence = trimmed.trim();
    if (fence.startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (!trimmed) {
      if (formatted.at(-1) !== '') formatted.push('');
      continue;
    }

    if (inFence || rawLine.startsWith('    ')) {
      formatted.push(formatCodeLine(rawLine));
      continue;
    }

    formatted.push(formatTextLine(trimmed));
  }
  return collapseBlankLines(formatted).join('\n').trim();
}

function formatTextLine(line: string) {
  const cleaned = stripMarkdown(line);
  if (/^\d+\.\s+/.test(cleaned)) {
    return `  ${cleaned}`;
  }
  if (/^[-*+]\s+/.test(cleaned)) {
    return `  • ${cleaned.replace(/^[-*+]\s+/, '')}`;
  }
  return cleaned;
}

function stripMarkdown(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)')
    .replace(/\\([*_`])/g, '$1');
}

function formatCodeLine(line: string) {
  return `    ${line.trim()}`;
}

function collapseBlankLines(lines: string[]) {
  return lines
    .reduce<string[]>((acc, line) => {
      if (!line && acc.at(-1) === '') return acc;
      acc.push(line);
      return acc;
    }, [])
    .filter((line, idx, arr) => !(line === '' && idx === arr.length - 1));
}
