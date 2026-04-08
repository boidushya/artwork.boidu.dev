export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
} as const;

export const Tag = {
  SERVER: 'server',
  HTTP: 'http',
  DB: 'db',
  CACHE_HIT: 'cache:hit',
  CACHE_MISS: 'cache:miss',
  CACHE_UPSERT: 'cache:upsert',
  CACHE: 'cache',
  SEARCH: 'search',
  ALBUM: 'album',
  M3U8: 'm3u8',
  TOKEN: 'token',
  MUT: 'mut',
  RATELIMIT: 'ratelimit',
} as const;

const TAG_COLORS: Record<string, string> = {
  server: ANSI.brightGreen,
  http: ANSI.brightCyan,
  db: ANSI.magenta,
  cache: ANSI.blue,
  'cache:hit': ANSI.green,
  'cache:miss': ANSI.yellow,
  'cache:upsert': ANSI.blue,
  search: ANSI.brightBlue,
  album: ANSI.brightBlue,
  m3u8: ANSI.cyan,
  token: ANSI.brightCyan,
  mut: ANSI.cyan,
  ratelimit: ANSI.brightMagenta,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: `${ANSI.dim}DEBUG${ANSI.reset}`,
  info: `${ANSI.brightGreen}INFO ${ANSI.reset}`,
  warn: `${ANSI.yellow}WARN ${ANSI.reset}`,
  error: `${ANSI.brightRed}ERROR${ANSI.reset}`,
};

function tagColor(tag: string): string {
  if (TAG_COLORS[tag]) return TAG_COLORS[tag];
  const base = tag.split(':')[0];
  return TAG_COLORS[base] ?? ANSI.white;
}

function formatTag(tag: string): string {
  return `${tagColor(tag)}[${tag}]${ANSI.reset}`;
}

function formatTime(d: Date): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` ${ANSI.red}${meta.name}: ${meta.message}${ANSI.reset}${meta.stack ? `\n${ANSI.dim}${meta.stack}${ANSI.reset}` : ''}`;
  }
  if (typeof meta === 'object' && meta !== null) {
    const pairs = Object.entries(meta as Record<string, unknown>)
      .map(([k, v]) => `${ANSI.dim}${k}${ANSI.reset}=${formatValue(v)}`)
      .join(' ');
    return ` ${pairs}`;
  }
  return ` ${formatValue(meta)}`;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(tag: string, msg: string, meta?: unknown): void;
  info(tag: string, msg: string, meta?: unknown): void;
  warn(tag: string, msg: string, meta?: unknown): void;
  error(tag: string, msg: string, meta?: unknown): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  const write = opts.write ?? ((line) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => new Date());

  function emit(level: LogLevel, tag: string, msg: string, meta: unknown): void {
    if (LEVEL_ORDER[level] < minLevel) return;
    const time = `${ANSI.dim}${formatTime(now())}${ANSI.reset}`;
    const line = `${time} ${LEVEL_LABEL[level]} ${formatTag(tag)} ${msg}${formatMeta(meta)}`;
    write(line);
  }

  return {
    debug(tag, msg, meta) {
      emit('debug', tag, msg, meta);
    },
    info(tag, msg, meta) {
      emit('info', tag, msg, meta);
    },
    warn(tag, msg, meta) {
      emit('warn', tag, msg, meta);
    },
    error(tag, msg, meta) {
      emit('error', tag, msg, meta);
    },
  };
}

function resolveLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') return env;
  return 'info';
}

export const log = createLogger({ level: resolveLevel() });
