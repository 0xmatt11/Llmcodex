const COMMON_REQUIRED = [
  'DISCORD_TOKEN',
  'DISCORD_CHANNEL_ID'
];

const X_CLIENT_MODES = new Set(['api', 'selenium']);

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function boolFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function required(env, names) {
  return names.filter((name) => !env[name]?.trim?.());
}

export function loadConfig(env = process.env) {
  const mode = (env.X_CLIENT_MODE ?? 'api').trim().toLowerCase();
  if (!X_CLIENT_MODES.has(mode)) {
    throw new Error(`X_CLIENT_MODE must be one of: ${[...X_CLIENT_MODES].join(', ')}`);
  }

  const requiredNames = [...COMMON_REQUIRED];
  if (mode === 'api') requiredNames.push('X_ACCESS_TOKEN', 'X_DM_CONVERSATION_ID');
  if (mode === 'selenium' && !env.X_DM_CONVERSATION_ID?.trim?.() && !env.X_SELENIUM_DM_URL?.trim?.()) {
    requiredNames.push('X_DM_CONVERSATION_ID or X_SELENIUM_DM_URL');
  }

  const missing = required(env, requiredNames);
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
      mode,
      accessToken: env.X_ACCESS_TOKEN?.trim?.() ?? '',
      conversationId: env.X_DM_CONVERSATION_ID?.trim?.() ?? '',
      apiBaseUrl: env.X_API_BASE_URL ?? 'https://api.x.com/2',
      pollIntervalMs: intFromEnv(env, 'X_POLL_INTERVAL_MS', 15000),
      pollLimit: intFromEnv(env, 'X_POLL_LIMIT', 50),
      maxAttachmentLinks: intFromEnv(env, 'X_MAX_ATTACHMENT_LINKS', 4),
      selenium: {
        remoteUrl: env.X_SELENIUM_REMOTE_URL ?? 'http://localhost:4444/wd/hub',
        browserName: env.X_SELENIUM_BROWSER ?? 'chrome',
        headless: boolFromEnv(env, 'X_SELENIUM_HEADLESS', true),
        profileDir: env.X_SELENIUM_PROFILE_DIR ?? '',
        baseUrl: env.X_SELENIUM_BASE_URL ?? 'https://x.com',
        dmUrl: env.X_SELENIUM_DM_URL ?? '',
        selfUserId: env.X_SELENIUM_SELF_USER_ID ?? 'selenium-self',
        eventSelector: env.X_SELENIUM_EVENT_SELECTOR ?? '[data-testid="messageEntry"]',
        eventIdAttribute: env.X_SELENIUM_EVENT_ID_ATTRIBUTE ?? 'data-message-id',
        messageTextSelector: env.X_SELENIUM_MESSAGE_TEXT_SELECTOR ?? '[data-testid="tweetText"], [dir="auto"]',
        senderSelector: env.X_SELENIUM_SENDER_SELECTOR ?? '[data-testid="User-Name"], [role="link"][href^="/"]',
        ownMessageSelector: env.X_SELENIUM_OWN_MESSAGE_SELECTOR ?? '',
        attachmentSelector: env.X_SELENIUM_ATTACHMENT_SELECTOR ?? 'a[href^="http"]',
        messageInputSelector: env.X_SELENIUM_MESSAGE_INPUT_SELECTOR ?? '[data-testid="dmComposerTextInput"]',
        sendButtonSelector: env.X_SELENIUM_SEND_BUTTON_SELECTOR ?? '[data-testid="dmComposerSendButton"]',
        waitTimeoutMs: intFromEnv(env, 'X_SELENIUM_WAIT_TIMEOUT_MS', 15000),
        capabilitiesJson: env.X_SELENIUM_CAPABILITIES_JSON ?? ''
      }
    }
  };
}
