#!/usr/bin/env node
import { writeFile } from 'fs/promises';
import readline from 'node:readline';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';
import os from 'node:os';
import chalk from 'chalk';
import clipboard from 'clipboardy';
import { Command } from 'commander';
import ora from 'ora';
import pkg from '../package.json' with { type: 'json' };
import { sendChat } from './api.js';
import {
  createProfile,
  deleteProfile,
  getConfigDirectory,
  getConfigPath,
  listProfiles,
  loadConfig,
  normalizeConfigKey,
  resolveProfile,
  setConfigValue,
  summarizeProfile,
} from './config.js';
import {
  appendHistory,
  clearHistory,
  getHistoryPath,
  getLastThread,
  readHistory,
  getHistoryStatus,
} from './history.js';
import {
  normalizeResponse,
  renderCitations,
  renderFollowUps,
  formatAnswerBlock,
} from './format.js';
import { parseMetadata, readFromStdin, timestamp, extractCodeBlocks } from './utils.js';

interface AskOptions {
  profile?: string;
  apiKey?: string;
  project?: string;
  integration?: string;
  baseUrl?: string;
  thread?: string;
  resume?: string | boolean;
  metadata?: string[];
  temperature?: string;
  user?: string;
  stream?: boolean;
  json?: boolean;
  stdin?: boolean;
  copy?: boolean;
  save?: string;
  output?: string;
  history?: boolean;
  quiet?: boolean;
  'no-history'?: boolean;
}

interface AskResult {
  prompt: string;
  answer: string;
  threadId?: string;
  questionAnswerId?: string;
}

const debugEnabled = process.env.DEBUG_KAPA === '1';
const debugLog = (...args: unknown[]) => {
  if (!debugEnabled) return;
  process.stderr.write(`[debug] ${args.map(String).join(' ')}\n`);
};

if (debugEnabled) {
  process.on('beforeExit', (code) => debugLog('beforeExit', code));
  process.on('exit', (code) => debugLog('exit', code));
  process.on('uncaughtException', (error) => {
    debugLog('uncaughtException', error?.stack ?? error);
  });
  process.on('unhandledRejection', (reason) => {
    debugLog('unhandledRejection', typeof reason === 'object' ? JSON.stringify(reason) : String(reason));
  });
}

const program = new Command();

program
  .name('kapa')
  .description('Interact with the Kapa AI HTTP API from the terminal.')
  .version(pkg.version);

program
  .argument('[prompt...]', 'Prompt to send to Kapa')
  .option('-p, --profile <name>', 'Select a config profile')
  .option('-k, --api-key <key>', 'Override API key')
  .option('--project <id>', 'Project id (required for new chats)')
  .option('--integration <id>', 'Integration id (required)')
  .option('-t, --thread <id>', 'Continue an existing thread id')
  .option('--resume [threadId]', 'Resume a thread (omit id to reuse last one)')
  .option('--metadata <pair...>', 'Attach metadata key=value pairs', collectValues, [] as string[])
  .option('--temperature <value>', 'Set response temperature')
  .option('--user <identifier>', 'Set user identifier')
  .option('--base-url <url>', 'Override API base URL')
  .option('--stdin', 'Read prompt from stdin')
  .option('--stream', 'Force-enable streaming output')
  .option('--no-stream', 'Disable streaming output')
  .option('--json', 'Return raw JSON from the API')
  .option('--copy', 'Copy the final answer to the clipboard')
  .option('--save <file>', 'Save the final answer to a file')
  .option('-o, --output <file>', 'Alias for --save')
  .option('--no-history', 'Skip writing to local history')
  .option('--quiet', 'Suppress spinner output')
  .action(async (promptParts: string[], options: AskOptions) => {
    try {
      debugLog(
        'entry',
        JSON.stringify({
          promptParts,
          stdinTTY: stdinStream.isTTY,
          stdoutTTY: stdoutStream.isTTY,
          interactive: shouldStartInteractiveSession(promptParts, options),
        }),
      );
      if (shouldStartInteractiveSession(promptParts, options)) {
        await startInteractiveSession(options);
        return;
      }
      await handleAsk(promptParts, options);
    } catch (error: any) {
      process.stderr.write(`${chalk.red('Error:')} ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('config')
  .description('Manage kapa CLI configuration')
  .argument('[action]', 'Action to perform (list, set, get, path, dir, profile)', 'list')
  .argument('[key]')
  .argument('[value]')
  .option('-p, --profile <name>', 'Target profile for get/set')
  .action(async (action: string, key: string | undefined, value: string | undefined, options) => {
    try {
      await handleConfig(action, key, value, options.profile);
    } catch (error: any) {
      process.stderr.write(`${chalk.red('Error:')} ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('history')
  .description('Inspect stored prompts/responses')
  .argument('[limitOrAction]', 'Number of entries to show or "clear"')
  .option('--json', 'Output as JSON')
  .action(async (limitOrAction: string | undefined, options: { json?: boolean }) => {
    try {
      await handleHistory(limitOrAction, options.json);
    } catch (error: any) {
      process.stderr.write(`${chalk.red('Error:')} ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('cache')
  .description('Manage cached history data')
  .argument('<action>', 'Currently only "clear" is supported')
  .action(async (action: string) => {
    try {
      if (action !== 'clear') {
        throw new Error('cache command supports only the "clear" action.');
      }
      await clearHistory();
      process.stdout.write(`${chalk.green('✓')} Cleared cached history (${getHistoryPath()})\n`);
    } catch (error: any) {
      process.stderr.write(`${chalk.red('Error:')} ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  });

function collectValues(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}

async function handleAsk(promptParts: string[], options: AskOptions): Promise<AskResult> {
  let prompt = promptParts.join(' ').trim();
  if (!prompt || options.stdin) {
    const stdinContent = await readFromStdin(Boolean(options.stdin));
    if (stdinContent) {
      prompt = prompt ? `${prompt}\n${stdinContent}` : stdinContent;
    }
  }

  if (!prompt) {
    throw new Error('No prompt provided. Pass text or pipe stdin with --stdin.');
  }

  const config = await loadConfig();
  const resolved = resolveProfile(config, options.profile);
  debugLog('handleAsk resolved profile', resolved.name);

  const apiKey =
    options.apiKey ?? process.env.KAPA_API_KEY ?? resolved.values.apiKey ?? '';
  const projectId =
    options.project ?? process.env.KAPA_PROJECT_ID ?? resolved.values.projectId ?? '';
  const integrationId =
    options.integration ??
    process.env.KAPA_INTEGRATION_ID ??
    resolved.values.integrationId ??
    '';
  const baseUrl = options.baseUrl ?? process.env.KAPA_BASE_URL ?? resolved.values.baseUrl;
  if (!apiKey) {
    throw new Error('API key missing. Set KAPA_API_KEY or run "kapa config set apiKey <value>".');
  }
  if (!integrationId) {
    throw new Error(
      'integration_id missing. Provide via --integration or "kapa config set integrationId <value>".',
    );
  }

  const streamPreference =
    typeof options.stream === 'boolean' ? options.stream : resolved.values.stream;
  const metadata = parseMetadata(options.metadata);
  const temperatureInput =
    options.temperature !== undefined
      ? Number(options.temperature)
      : resolved.values.temperature ?? undefined;
  const finalTemperature =
    typeof temperatureInput === 'number' && Number.isFinite(temperatureInput)
      ? temperatureInput
      : undefined;
  const userIdentifier = options.user;
  const resumeValue = options.resume === true ? 'last' : options.resume;
  let threadId =
    options.thread ??
    (typeof resumeValue === 'string' && resumeValue !== 'last' ? resumeValue : undefined);
  debugLog('handleAsk initial state', JSON.stringify({ threadId, streamPreference }));

  if (!threadId && resumeValue === 'last') {
    threadId = await getLastThread(resolved.name) ?? undefined;
    if (!threadId && options.resume) {
      throw new Error('No recent thread found to resume.');
    }
  }
  if (!threadId && !projectId) {
    throw new Error(
      'Project id is required to start a new chat. Provide via --project or config.',
    );
  }

  const spinner = ora('Waiting for Kapa');
  const spinnerEnabled = !options.json && !options.quiet;
  if (spinnerEnabled) spinner.start();

  let streamedAnswer = '';
  let headerShown = false;
  const onStreamEvent = (event: { text?: string }) => {
    if (!streamPreference || !event.text) return;
    if (!headerShown) {
      if (spinnerEnabled) spinner.stop();
      process.stdout.write(`${chalk.bold('Kapa')} ${chalk.dim('streaming…')}\n\n`);
      headerShown = true;
    }
    streamedAnswer += event.text;
    process.stdout.write(event.text);
  };

  const response = await sendChat({
    apiKey,
    projectId,
    integrationId,
    prompt,
    metadata,
    userIdentifier,
    temperature: finalTemperature,
    baseUrl,
    threadId,
    stream: streamPreference,
    onStreamEvent,
  }).finally(() => {
    if (spinnerEnabled) spinner.stop();
  });
  debugLog('handleAsk response', JSON.stringify({ streamed: response.streamed }));

  const normalized = normalizeResponse(response.data ?? {});
  const answer = streamedAnswer || normalized.answer || '';
  threadId = normalized.threadId || response.data?.thread_id || threadId;
  const questionAnswerId = normalized.questionAnswerId;

  const usedStreaming = Boolean(streamPreference && response.streamed);
  debugLog('handleAsk normalized', JSON.stringify({ threadId, usedStreaming }));

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.data, null, 2)}\n`);
  } else if (!usedStreaming) {
    process.stdout.write(`${chalk.bold('Kapa')} ${chalk.dim('response')}\n\n`);
    process.stdout.write(`${formatAnswerBlock(answer)}\n\n`);
    const followUps = renderFollowUps(normalized.followUps);
    if (followUps) {
      process.stdout.write(`${followUps}\n\n`);
    }
    const citations = renderCitations(normalized.citations);
    if (citations) {
      process.stdout.write(`${citations}\n`);
    }
  } else {
    if (!streamedAnswer && answer) {
      process.stdout.write(`${chalk.bold('Kapa')} ${chalk.dim('response')}\n\n`);
      process.stdout.write(`${formatAnswerBlock(answer)}\n`);
    }
    process.stdout.write('\n');
    const followUps = renderFollowUps(normalized.followUps);
    if (followUps) {
      process.stdout.write(`\n${followUps}\n`);
    }
    const citations = renderCitations(normalized.citations);
    if (citations) {
      process.stdout.write(`\n${citations}\n`);
    }
  }

  if (options.copy) {
    await clipboard
      .write(answer)
      .then(() => process.stderr.write(`${chalk.green('✓')} Copied answer to clipboard.\n`))
      .catch(() =>
        process.stderr.write(`${chalk.yellow('!')} Could not access clipboard utility.\n`),
      );
  }

  const targetFile = options.save ?? options.output;
  if (targetFile) {
    await fsWrite(targetFile, answer);
    process.stderr.write(`${chalk.green('✓')} Saved answer to ${targetFile}\n`);
  }

  if (options.history !== false) {
    await appendHistory({
      timestamp: timestamp(),
      profile: resolved.name,
      prompt,
      response: answer,
      threadId,
      questionAnswerId,
      metadata,
    });
    debugLog('history written');
  }

  if (threadId) {
    process.stderr.write(`${chalk.dim('Thread ID:')} ${threadId}\n`);
  }
  if (questionAnswerId) {
    process.stderr.write(`${chalk.dim('Question Answer ID:')} ${questionAnswerId}\n`);
  }

  return { prompt, answer, threadId, questionAnswerId };
}

async function handleConfig(action: string, key?: string, value?: string, profile?: string) {
  switch (action) {
    case 'list': {
      const info = await listProfiles();
      for (const [name, profileConfig] of Object.entries(info.profiles)) {
        const summary = summarizeProfile(profileConfig as any);
        const header =
          name === info.defaultProfile ? `${chalk.bold(name)} ${chalk.dim('(default)')}` : chalk.bold(name);
        process.stdout.write(`${header}\n`);
        for (const [field, fieldValue] of Object.entries(summary)) {
          process.stdout.write(
            `  ${chalk.dim(field.padEnd(14))}${fieldValue ?? chalk.dim('(unset)')}\n`,
          );
        }
        process.stdout.write('\n');
      }
      return;
    }
    case 'path':
      process.stdout.write(`${getConfigPath()}\n`);
      return;
    case 'dir':
      process.stdout.write(`${getConfigDirectory()}\n`);
      return;
    case 'set': {
      if (!key || value === undefined) {
        throw new Error('Usage: kapa config set <key> <value>');
      }
      const result = await setConfigValue(key, value, { profile });
      const scope = result.profile ? ` (${result.profile})` : '';
      process.stdout.write(
        `${chalk.green('✓')} Saved ${result.key}${scope}: ${String(result.value)}\n`,
      );
      return;
    }
    case 'get': {
      if (!key) throw new Error('Usage: kapa config get <key>');
      const cfg = await loadConfig();
      const normalized = normalizeConfigKey(key);
      if (normalized === 'defaultProfile') {
        process.stdout.write(`${cfg.defaultProfile}\n`);
        return;
      }
      const resolved = resolveProfile(cfg, profile ?? cfg.defaultProfile);
      const valueToShow = resolved.values[normalized as keyof typeof resolved.values];
      if (valueToShow === undefined || valueToShow === null || valueToShow === '') {
        process.stdout.write(`${chalk.dim('undefined')}\n`);
      } else if (typeof valueToShow === 'object') {
        process.stdout.write(`${JSON.stringify(valueToShow, null, 2)}\n`);
      } else {
        process.stdout.write(`${valueToShow}\n`);
      }
      return;
    }
    case 'profile': {
      const subAction = key;
      const target = value;
      if (!subAction || !target) {
        throw new Error('Usage: kapa config profile <use|create|delete> <name>');
      }
      if (subAction === 'use') {
        await setConfigValue('defaultProfile', target);
        process.stdout.write(`${chalk.green('✓')} Default profile set to ${target}\n`);
        return;
      }
      if (subAction === 'create') {
        await createProfile(target);
        process.stdout.write(`${chalk.green('✓')} Created profile ${target}\n`);
        return;
      }
      if (subAction === 'delete') {
        await deleteProfile(target);
        process.stdout.write(`${chalk.green('✓')} Deleted profile ${target}\n`);
        return;
      }
      throw new Error('Profile action must be one of use, create, delete.');
    }
    default:
      throw new Error(`Unknown config action "${action}".`);
  }
}

async function handleHistory(limitOrAction?: string, jsonOutput?: boolean) {
  const status = getHistoryStatus();
  if (limitOrAction === 'clear') {
    await clearHistory();
    process.stdout.write(`${chalk.green('✓')} Cleared history (${getHistoryPath()})\n`);
    return;
  }

  const limit = limitOrAction ? Number.parseInt(limitOrAction, 10) : 10;
  const entries = await readHistory(Number.isFinite(limit) ? limit : 10);

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }

  if (!entries.length) {
    if (status.disabled && status.reason) {
      process.stdout.write(`${chalk.dim(`History disabled: ${status.reason}`)}\n`);
    } else {
      process.stdout.write(`${chalk.dim('No history yet. Ask something!')}\n`);
    }
    return;
  }

  entries.forEach((entry, idx) => {
    process.stdout.write(`${chalk.bold(`#${idx + 1}`)} ${chalk.dim(entry.timestamp)}\n`);
    process.stdout.write(`${chalk.cyan('Prompt:')} ${entry.prompt}\n`);
    const replyBlock = formatAnswerBlock(entry.response);
    process.stdout.write(`${chalk.green('Reply:')} ${replyBlock}\n`);
    if (entry.threadId) {
      process.stdout.write(`${chalk.dim('Thread:')} ${entry.threadId}\n`);
    }
    process.stdout.write('\n');
  });
}

async function fsWrite(target: string, content: string) {
  await writeFile(target, content, 'utf8');
}

void program.parseAsync(process.argv);

function shouldStartInteractiveSession(promptParts: string[], options: AskOptions) {
  const hasPrompt = promptParts.some((part) => Boolean(part.trim()));
  if (hasPrompt) return false;
  if (options.stdin) return false;
  const forceInteractive = process.env.KAPA_FORCE_INTERACTIVE === '1';
  if (!stdinStream.isTTY || !stdoutStream.isTTY) {
    debugLog('tty check failed', `stdin=${stdinStream.isTTY}`, `stdout=${stdoutStream.isTTY}`);
    return forceInteractive;
  }
  if (options.json) return false;
  return true;
}

async function startInteractiveSession(options: AskOptions) {
  const config = await loadConfig();
  const resolved = resolveProfile(config, options.profile);
  const baseOptions: AskOptions = { ...options, thread: undefined, resume: undefined };
  let currentThreadId = await resolveInitialThreadId(options, resolved.name);
  let lastAnswer: string | undefined;
  debugLog(
    'startInteractiveSession',
    JSON.stringify({
      profile: resolved.name,
      thread: currentThreadId,
      stdinTTY: stdinStream.isTTY,
      stdoutTTY: stdoutStream.isTTY,
    }),
  );

  renderLogoArt();
  renderInteractiveBanner({
    version: pkg.version,
    profile: resolved.name,
    projectId: resolved.values.projectId,
    integrationId: resolved.values.integrationId,
  });
  printInteractiveIntro();

  if (typeof stdinStream.setRawMode === 'function') {
    try {
      stdinStream.setRawMode(false);
    } catch (error) {
      debugLog('setRawMode error', error);
    }
  }
  stdinStream.resume();

  const rl = readline.createInterface({
    input: stdinStream,
    output: stdoutStream,
    terminal: true,
  });
  debugLog('readline created');

  let closing = false;
  let processing = false;
  const promptLabel = renderInputPrompt();
  const showPrompt = () => {
    if (closing || processing) return;
    stdinStream.resume();
    rl.resume();
    rl.setPrompt(promptLabel);
    rl.prompt();
  };
  const finishSession = () => {
    if (closing) return;
    closing = true;
    stdinStream.pause();
    rl.close();
  };

  rl.on('SIGINT', () => {
    process.stdout.write(`\n${chalk.dim('Session ended (Ctrl+C).')}\n`);
    finishSession();
  });
  stdinStream.on('end', () => {
    debugLog('stdin end event');
    finishSession();
  });
  stdinStream.on('close', () => {
    debugLog('stdin close event');
    finishSession();
  });
  stdinStream.on('pause', () => debugLog('stdin pause'));
  stdinStream.on('resume', () => debugLog('stdin resume'));

  const closedPromise = new Promise<void>((resolve) => {
    rl.on('close', () => {
      debugLog('readline close event');
      process.stderr.write(`${chalk.dim('Goodbye!')}\n`);
      resolve();
    });
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    debugLog('input', JSON.stringify(trimmed));
    if (!trimmed) {
      showPrompt();
      return;
    }

    if (trimmed.startsWith('/')) {
      stdinStream.pause();
      rl.pause();
      const shouldContinue = await handleInteractiveCommand(trimmed.slice(1), {
        getThreadId: () => currentThreadId,
        setThreadId: (value?: string) => {
          currentThreadId = value;
        },
        getLastAnswer: () => lastAnswer,
      });
      if (!shouldContinue) {
        finishSession();
        return;
      }
      stdinStream.resume();
      rl.resume();
      showPrompt();
      return;
    }

    try {
      stdinStream.pause();
      rl.pause();
      processing = true;
      const result = await handleAsk([trimmed], { ...baseOptions, thread: currentThreadId });
      currentThreadId = result.threadId ?? currentThreadId;
      lastAnswer = result.answer;
      debugLog('ask handled', JSON.stringify({ thread: currentThreadId }));
    } catch (error: any) {
      process.stderr.write(`${chalk.red('Error:')} ${error?.message ?? error}\n`);
    } finally {
      processing = false;
      stdinStream.resume();
      rl.resume();
    }
    showPrompt();
  });

  showPrompt();
  await closedPromise;
}

async function resolveInitialThreadId(options: AskOptions, profileName: string) {
  if (options.thread) return options.thread;
  const resumeValue = options.resume === true ? 'last' : options.resume;
  if (resumeValue && resumeValue !== 'last') {
    return resumeValue;
  }
  if (resumeValue === 'last') {
    return (await getLastThread(profileName)) ?? undefined;
  }
  return undefined;
}

const LETTER_MAP = {
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
} as const;

const LOGO_WORD = ['K', 'A', 'P', 'A'] as const;

const KAPA_LOGO = LETTER_MAP.K.map((_, row) =>
  LOGO_WORD.map((letter) => LETTER_MAP[letter as keyof typeof LETTER_MAP][row]).join('  '),
);

const LOGO_COLORS = ['#0A68F1', '#4C7BFF', '#FF4B5C'];

function renderLogoArt() {
  const width = Math.max(...KAPA_LOGO.map((line) => line.length));
  KAPA_LOGO.forEach((line, row) => {
    let rendered = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === ' ') {
        rendered += ' ';
        continue;
      }
      const ratio = (i + row / KAPA_LOGO.length) / width;
      const color = gradientColor(LOGO_COLORS, ratio);
      rendered += chalk.hex(color)(char);
    }
    process.stdout.write(`${rendered}\n`);
  });
  process.stdout.write('\n');
}

function gradientColor(colors: string[], ratio: number) {
  if (colors.length === 1) return colors[0];
  const clamped = Math.min(1, Math.max(0, ratio));
  const segment = 1 / (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(clamped / segment));
  const start = hexToRgb(colors[index]);
  const end = hexToRgb(colors[index + 1]);
  const localT = (clamped - index * segment) / segment;
  const mixed = start.map((startChannel, idx) =>
    Math.round(startChannel + (end[idx] - startChannel) * localT),
  );
  return rgbToHex(mixed as [number, number, number]);
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const bigint = Number.parseInt(normalized, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function renderInteractiveBanner(details: {
  version: string;
  profile: string;
  projectId?: string;
  integrationId?: string;
}) {
  const cwd = process.cwd();
  const home = os.homedir();
  const displayCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

  const content = [
    `>_ Kapa CLI (v${details.version})`,
    '',
    `profile: ${details.profile}`,
    `project: ${details.projectId || '(unset)'}`,
    `integration: ${details.integrationId || '(unset)'}`,
    `directory: ${displayCwd}`,
  ];

  const innerWidth = Math.max(44, ...content.map((line) => line.length));
  const horizontal = '─'.repeat(innerWidth + 2);
  const top = `╭${horizontal}╮`;
  const bottom = `╰${horizontal}╯`;
  const body = content
    .map((line) => `│ ${line.padEnd(innerWidth, ' ')} │`)
    .join('\n');

  process.stdout.write(`${top}\n${body}\n${bottom}\n\n`);
}

function printInteractiveIntro() {
  process.stdout.write(
    'Type your task or use a command:\n\n' +
      '  /help    Show available commands\n' +
      '  /reset   Start a fresh thread\n' +
      '  /thread  Show the active thread id\n' +
      '  /history View recent history entries\n' +
      '  /exit    Leave the session\n\n',
  );
}

function renderInputPrompt() {
  const badge = chalk.bgBlackBright(chalk.white(' prompt '));
  return `${badge} ${chalk.cyan('You')} ${chalk.dim('› ')}`;
}

async function handleInteractiveCommand(
  input: string,
  context: {
    getThreadId: () => string | undefined;
    setThreadId: (value?: string) => void;
    getLastAnswer: () => string | undefined;
  },
) {
  const [command, ...args] = input.trim().split(/\s+/);
  switch (command.toLowerCase()) {
    case 'exit':
    case 'quit':
      debugLog('command exit');
      return false;
    case 'help':
      printInteractiveIntro();
      return true;
    case 'reset':
      context.setThreadId(undefined);
      debugLog('command reset');
      process.stdout.write(`${chalk.green('✓')} Started a new thread for follow-up questions.\n`);
      return true;
    case 'thread': {
      const threadId = context.getThreadId();
      debugLog('command thread', threadId);
      if (threadId) {
        process.stdout.write(`${chalk.dim('Current thread:')} ${threadId}\n`);
      } else {
        process.stdout.write(`${chalk.dim('No active thread yet. Ask something!')}\n`);
      }
      return true;
    }
    case 'history': {
      const limit = args[0];
      debugLog('command history', limit);
      await handleHistory(limit, false);
      return true;
    }
    case 'cptext': {
      const answer = context.getLastAnswer();
      if (!answer) {
        process.stdout.write(`${chalk.dim('Nothing to copy yet – ask something first.')}\n`);
        return true;
      }
      await clipboard.write(answer).then(() =>
        process.stdout.write(`${chalk.green('✓')} Copied last response to clipboard.\n`),
      ).catch(() =>
        process.stderr.write(`${chalk.yellow('!')} Clipboard unavailable.\n`),
      );
      return true;
    }
    case 'cpcmd': {
      const answer = context.getLastAnswer();
      if (!answer) {
        process.stdout.write(`${chalk.dim('Nothing to copy yet – ask something first.')}\n`);
        return true;
      }
      const commands = extractCodeBlocks(answer);
      if (!commands.length) {
        process.stdout.write(`${chalk.dim('No commands found in the last response.')}\n`);
        return true;
      }
      const combined = commands.join('\n\n');
      await clipboard.write(combined).then(() =>
        process.stdout.write(`${chalk.green('✓')} Copied command block to clipboard.\n`),
      ).catch(() =>
        process.stderr.write(`${chalk.yellow('!')} Clipboard unavailable.\n`),
      );
      return true;
    }
    default:
      debugLog('command unknown', command);
      process.stdout.write(`${chalk.yellow('Unknown command:')} /${command}\n`);
      process.stdout.write(`Type ${chalk.cyan('/help')} to see available commands.\n`);
      return true;
  }
}
