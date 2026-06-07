const X_TRANSPORTS = new Set(['selenium', 'api']);
const BASE_REQUIRED = [
  'DISCORD_TOKEN',
  'DISCORD_CHANNEL_ID'
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

function xTransportFromEnv(env) {
  const transport = (env.X_TRANSPORT ?? 'selenium').toLowerCase();
  if (!X_TRANSPORTS.has(transport)) {
    throw new Error('X_TRANSPORT must be either "selenium" or "api"');
  }
  return transport;
}

function requiredForTransport(transport) {
  if (transport === 'api') return ['X_ACCESS_TOKEN', 'X_DM_CONVERSATION_ID'];
  return ['X_GROUP_DM_URL', 'X_SELF_USER_ID'];
}

export function loadConfig(env = process.env) {
  const transport = xTransportFromEnv(env);
  const required = [...BASE_REQUIRED, ...requiredForTransport(transport)];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const seleniumConversationId = env.X_GROUP_DM_URL ?? '';
  const apiConversationId = env.X_DM_CONVERSATION_ID ?? '';

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: intFromEnv(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    sqlitePath: env.SQLITE_PATH ?? './data/bridge.sqlite',
    publicBaseUrl: env.BRIDGE_PUBLIC_BASE_URL ?? '',
    discord: {
      token: env.DISCORD_TOKEN,
      channelId: env.DISCORD_CHANNEL_ID
    },
    x: {
      transport,
      conversationId: transport === 'api' ? apiConversationId : seleniumConversationId,
      pollIntervalMs: intFromEnv(env, 'X_POLL_INTERVAL_MS', 15000),
      pollLimit: intFromEnv(env, 'X_POLL_LIMIT', 50),
      maxAttachmentLinks: intFromEnv(env, 'X_MAX_ATTACHMENT_LINKS', 4),
      api: {
        accessToken: env.X_ACCESS_TOKEN ?? '',
        conversationId: apiConversationId,
        apiBaseUrl: env.X_API_BASE_URL ?? 'https://api.x.com/2'
      },
      selenium: {
        groupDmUrl: seleniumConversationId,
        selfUserId: env.X_SELF_USER_ID ?? '',
        cookiesJson: env.X_COOKIES_JSON ?? '',
        cookieBootstrapUrl: env.X_COOKIE_BOOTSTRAP_URL ?? 'https://x.com',
        userDataDir: env.X_BROWSER_USER_DATA_DIR ?? './browser-data',
        binaryPath: env.CHROME_BIN ?? '',
        headless: env.X_BROWSER_HEADLESS !== 'false',
        noSandbox: env.X_BROWSER_NO_SANDBOX !== 'false',
        windowSize: env.X_BROWSER_WINDOW_SIZE ?? '1280,1000',
        messageSelector: env.X_MESSAGE_SELECTOR ?? '[data-testid="messageEntry"]',
        composerSelector: env.X_COMPOSER_SELECTOR ?? '[data-testid="dmComposerTextInput"]',
        sendButtonSelector: env.X_SEND_BUTTON_SELECTOR ?? '[data-testid="dmComposerSendButton"]',
        visibleMessageScanLimit: intFromEnv(env, 'X_VISIBLE_MESSAGE_SCAN_LIMIT', 100),
        sendAttempts: intFromEnv(env, 'X_SEND_ATTEMPTS', 3),
        readyTimeoutMs: intFromEnv(env, 'X_READY_TIMEOUT_MS', 30000),
        implicitWaitMs: intFromEnv(env, 'X_IMPLICIT_WAIT_MS', 250),
        pageLoadTimeoutMs: intFromEnv(env, 'X_PAGE_LOAD_TIMEOUT_MS', 60000),
        scriptTimeoutMs: intFromEnv(env, 'X_SCRIPT_TIMEOUT_MS', 30000)
      }
    }
  };
}
