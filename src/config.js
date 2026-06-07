const REQUIRED = [
  'DISCORD_TOKEN',
  'DISCORD_CHANNEL_ID',
  'X_ACCESS_TOKEN',
  'X_DM_CONVERSATION_ID'
];

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]?.trim?.());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: intFromEnv(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    sqlitePath: env.SQLITE_PATH ?? './data/bridge.sqlite',
    publicBaseUrl: env.BRIDGE_PUBLIC_BASE_URL ?? '',
    discord: {
      token: env.DISCORD_TOKEN.trim(),
      channelId: env.DISCORD_CHANNEL_ID.trim()
    },
    x: {
      accessToken: env.X_ACCESS_TOKEN.trim(),
      conversationId: env.X_DM_CONVERSATION_ID.trim(),
      apiBaseUrl: env.X_API_BASE_URL ?? 'https://api.x.com/2',
      pollIntervalMs: intFromEnv(env, 'X_POLL_INTERVAL_MS', 15000),
      pollLimit: intFromEnv(env, 'X_POLL_LIMIT', 50),
      maxAttachmentLinks: intFromEnv(env, 'X_MAX_ATTACHMENT_LINKS', 4)
    }
  };
}
