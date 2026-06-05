import pino from 'pino';

const SECRET_PATTERNS = [
  /DISCORD_TOKEN=[^\s]+/gi,
  /X_ACCESS_TOKEN=[^\s]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /Bot\s+[A-Za-z0-9._~+/-]+=*/g
];

export function redact(value) {
  if (typeof value !== 'string') return value;
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value);
}

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        '*.token',
        '*.accessToken',
        '*.authorization',
        'req.headers.authorization',
        'headers.authorization',
        'discord.token',
        'x.accessToken'
      ],
      censor: '[REDACTED]'
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(redact));
      }
    }
  });
}
