import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRouter, renderForDiscord, renderForX, shouldBridge, textHash } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { createXClient, SeleniumXClient, XApiClient, XClient } from '../src/xClient.js';

class MemoryStore {
  constructor() {
    this.events = new Set();
    this.mappings = new Map();
    this.recorded = [];
    this.outboundTextHashes = new Set();
  }

  key(source, id, target) {
    return `${source}:${id}:${target}`;
  }

  getMapping(source, id, target) {
    return this.mappings.get(this.key(source, id, target));
  }

  recordEvent(key) {
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }

  releaseEvent(key) {
    return this.events.delete(key);
  }

  recordMapping(mapping) {
    this.recorded.push(mapping);
    this.mappings.set(this.key(mapping.source, mapping.sourceMessageId, mapping.target), mapping);
  }

  recordOutboundMessage({ target, textHash }) {
    this.outboundTextHashes.add(`${target}:${textHash}`);
  }

  hasOutboundTextHash(target, textHash) {
    return this.outboundTextHashes.has(`${target}:${textHash}`);
  }
}

function discordMessage(overrides = {}) {
  return {
    id: 'd1',
    channelId: 'channel-1',
    content: 'hello x',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    author: { id: 'user-1', username: 'Ada', bot: false },
    attachments: new Map(),
    ...overrides
  };
}

test('shouldBridge dedupes repeated source events', () => {
  const store = new MemoryStore();
  const first = shouldBridge({ store, source: 'discord', sourceMessageId: '1', target: 'x', authorId: 'u' });
  const second = shouldBridge({ store, source: 'discord', sourceMessageId: '1', target: 'x', authorId: 'u' });

  assert.equal(first.bridge, true);
  assert.deepEqual(second, { bridge: false, reason: 'duplicate_event' });
});

test('shouldBridge skips mapped and self messages', () => {
  const store = new MemoryStore();
  store.recordMapping({ source: 'x', sourceMessageId: 'x1', target: 'discord' });

  assert.deepEqual(
    shouldBridge({ store, source: 'x', sourceMessageId: 'x1', target: 'discord', authorId: 'u' }),
    { bridge: false, reason: 'already_mapped' }
  );
  assert.deepEqual(
    shouldBridge({ store, source: 'x', sourceMessageId: 'x2', target: 'discord', authorId: 'self', selfIds: ['self'] }),
    { bridge: false, reason: 'self_message' }
  );
});

test('BridgeRouter routes configured Discord channel to X and records mapping', async () => {
  const store = new MemoryStore();
  const xClient = { sendDm: async (_conversationId, text) => ({ id: `x-${text.length}` }) };
  const router = new BridgeRouter({
    store,
    xClient,
    discordClient: { user: { id: 'bot-1' } },
    logger: { info() {} },
    config: { discord: { channelId: 'channel-1' }, x: { conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  const result = await router.bridgeDiscordMessage(discordMessage());

  assert.equal(result.bridged, true);
  assert.equal(store.recorded[0].direction, 'discord_to_x');
  assert.equal(store.recorded[0].sourceMessageId, 'd1');
});

test('BridgeRouter skips Discord messages from other channels and bots', async () => {
  const store = new MemoryStore();
  const router = new BridgeRouter({
    store,
    xClient: { sendDm: async () => assert.fail('should not send') },
    discordClient: { user: { id: 'bot-1' } },
    logger: { info() {} },
    config: { discord: { channelId: 'channel-1' }, x: { conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  assert.deepEqual(await router.bridgeDiscordMessage(discordMessage({ channelId: 'other' })), { skipped: 'wrong_channel' });
  assert.deepEqual(await router.bridgeDiscordMessage(discordMessage({ author: { id: 'bot-2', bot: true } })), { skipped: 'bot_message' });
});

test('BridgeRouter records Selenium outbound text hashes and skips matching self echoes', async () => {
  const store = new MemoryStore();
  const sentMessages = [];
  const discordClient = {
    user: { id: 'bot-1' },
    channels: {
      fetch: async () => ({
        send: async (payload) => {
          sentMessages.push(payload);
          return { id: 'd-sent' };
        }
      })
    }
  };
  const router = new BridgeRouter({
    store,
    discordClient,
    xClient: {
      sendDm: async (_conversationId, text) => ({ id: `selenium-sent-${text.length}` }),
      getAuthenticatedUserId: async () => 'selenium-self'
    },
    logger: { info() {} },
    config: { discord: { channelId: 'channel-1' }, x: { mode: 'selenium', conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  const discord = discordMessage({ content: 'persist me' });
  await router.bridgeDiscordMessage(discord);
  const echoedText = renderForX({
    source: 'discord',
    id: discord.id,
    authorId: discord.author.id,
    authorName: discord.author.username,
    text: discord.content,
    attachments: [],
    createdAt: discord.createdAt.toISOString()
  });

  assert.equal(store.hasOutboundTextHash('x', textHash(echoedText)), true);
  assert.deepEqual(await router.bridgeXMessage({ id: 'x-echo', sender_id: 'unknown', text: echoedText }), { skipped: 'self_message' });
  assert.equal(sentMessages.length, 0);
});

test('BridgeRouter routes X DM events to Discord and records mapping', async () => {
  const store = new MemoryStore();
  const sentMessages = [];
  const discordClient = {
    channels: {
      fetch: async () => ({
        send: async (payload) => {
          sentMessages.push(payload);
          return { id: 'd-sent' };
        }
      })
    }
  };
  const router = new BridgeRouter({
    store,
    discordClient,
    xClient: { getAuthenticatedUserId: async () => 'x-self' },
    logger: { info() {} },
    config: { discord: { channelId: 'channel-1' }, x: { conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  const result = await router.bridgeXMessage({ id: 'x1', sender_id: 'x-other', text: 'hello discord' });

  assert.equal(result.bridged, true);
  assert.match(sentMessages[0].content, /hello discord/);
  assert.equal(store.recorded[0].direction, 'x_to_discord');
});

test('renderers include attachment links and placeholders', () => {
  const message = {
    authorName: '@everyone',
    text: 'file attached',
    attachments: [{ url: 'https://example.com/a.png' }, { name: 'private.bin' }]
  };

  assert.match(renderForX(message), /https:\/\/example.com\/a.png/);
  assert.match(renderForX(message), /omitted/);
  assert.match(renderForDiscord(message), /@​everyone/);
  assert.match(renderForDiscord(message), /unavailable/);
});


test('BridgeRouter releases Discord-to-X dedupe reservation when send fails', async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const router = new BridgeRouter({
    store,
    xClient: {
      sendDm: async () => {
        attempts += 1;
        throw new Error('x unavailable');
      }
    },
    discordClient: { user: { id: 'bot-1' } },
    logger: { info() {}, warn() {} },
    config: { discord: { channelId: 'channel-1' }, x: { conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  await assert.rejects(() => router.bridgeDiscordMessage(discordMessage()), /x unavailable/);
  await assert.rejects(() => router.bridgeDiscordMessage(discordMessage()), /x unavailable/);

  assert.equal(attempts, 2);
});

test('BridgeRouter disables Discord mentions and releases X-to-Discord dedupe reservation when send fails', async () => {
  const store = new MemoryStore();
  const sentMessages = [];
  let fail = true;
  const discordClient = {
    channels: {
      fetch: async () => ({
        send: async (payload) => {
          sentMessages.push(payload);
          if (fail) throw new Error('discord unavailable');
          return { id: 'd-sent' };
        }
      })
    }
  };
  const router = new BridgeRouter({
    store,
    discordClient,
    xClient: { getAuthenticatedUserId: async () => 'x-self' },
    logger: { info() {}, warn() {} },
    config: { discord: { channelId: 'channel-1' }, x: { conversationId: 'dm-1', maxAttachmentLinks: 4 } }
  });

  await assert.rejects(() => router.bridgeXMessage({ id: 'x2', sender_id: 'x-other', text: '@everyone hello' }), /discord unavailable/);
  fail = false;
  const result = await router.bridgeXMessage({ id: 'x2', sender_id: 'x-other', text: '@everyone hello' });

  assert.equal(result.bridged, true);
  assert.deepEqual(sentMessages.at(-1).allowedMentions, { parse: [] });
  assert.match(sentMessages.at(-1).content, /@​everyone/);
});

test('XClient treats non-JSON retryable responses as retryable before parsing', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('not json', { status: attempts === 1 ? 500 : 200, headers: { 'content-type': 'text/plain' } });
  };

  try {
    const client = new XClient({ accessToken: 'token', apiBaseUrl: 'https://api.example.test/2', logger: { warn() {} } });
    await assert.rejects(() => client.request('/test'), SyntaxError);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('loadConfig defaults to X API mode and requires API credentials', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_ACCESS_TOKEN: 'x-token',
    X_DM_CONVERSATION_ID: 'dm-1'
  });

  assert.equal(config.x.mode, 'api');
  assert.equal(config.x.accessToken, 'x-token');
  assert.equal(config.x.apiBaseUrl, 'https://api.x.com/2');
});

test('loadConfig supports Selenium mode without an X API token', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'selenium',
    X_DM_CONVERSATION_ID: 'dm-1',
    X_SELENIUM_REMOTE_URL: 'http://selenium.example.test/wd/hub',
    X_SELENIUM_HEADLESS: 'false'
  });

  assert.equal(config.x.mode, 'selenium');
  assert.equal(config.x.accessToken, '');
  assert.equal(config.x.selenium.remoteUrl, 'http://selenium.example.test/wd/hub');
  assert.equal(config.x.selenium.headless, false);
});

test('loadConfig reports a clear Selenium DM target error', () => {
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'selenium'
  }), /Selenium mode requires either X_DM_CONVERSATION_ID or X_SELENIUM_DM_URL/);
});

test('loadConfig rejects unknown X client modes', () => {
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'browser-ish'
  }), /X_CLIENT_MODE must be one of/);
});

test('createXClient selects API or Selenium implementation from config', () => {
  const logger = { info() {}, warn() {} };
  const apiConfig = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_ACCESS_TOKEN: 'x-token',
    X_DM_CONVERSATION_ID: 'dm-1'
  });
  const seleniumConfig = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'selenium',
    X_DM_CONVERSATION_ID: 'dm-1'
  });

  assert.ok(createXClient({ config: apiConfig, logger }) instanceof XApiClient);
  assert.ok(createXClient({ config: seleniumConfig, logger }) instanceof SeleniumXClient);
});

test('SeleniumXClient builds synthetic event IDs from stable message data', () => {
  const client = new SeleniumXClient({
    logger: { info() {}, warn() {} },
    selenium: loadConfig({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_CHANNEL_ID: 'channel-1',
      X_CLIENT_MODE: 'selenium',
      X_DM_CONVERSATION_ID: 'dm-1',
      X_SELENIUM_SELF_USER_ID: 'self-user'
    }).x.selenium
  });

  const first = client.eventId({
    elementId: 'transient-webdriver-element-1',
    text: 'stable message',
    index: 3,
    senderText: 'Ada',
    attachmentUrls: [{ url: 'https://example.test/a.png' }]
  });
  const second = client.eventId({
    elementId: 'transient-webdriver-element-2',
    text: 'stable message',
    index: 3,
    senderText: 'Ada',
    attachmentUrls: [{ url: 'https://example.test/a.png' }]
  });

  assert.equal(first, second);
  assert.notEqual(client.eventId({ text: 'stable message', index: 3, senderText: 'Grace' }), first);
  assert.equal(client.eventId({ rawId: 'native-id-1', text: 'ignored', index: 0 }), 'native-id-1');
});

test('SeleniumXClient accepts non-numeric event IDs for cursor storage', () => {
  const client = new SeleniumXClient({
    logger: { info() {}, warn() {} },
    selenium: loadConfig({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_CHANNEL_ID: 'channel-1',
      X_CLIENT_MODE: 'selenium',
      X_DM_CONVERSATION_ID: 'dm-1'
    }).x.selenium
  });

  assert.equal(client.isValidEventId('selenium-event:abc123'), true);
  assert.equal(client.isValidEventId(''), false);
});

test('SeleniumXClient merges configured browser option arguments', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'selenium',
    X_DM_CONVERSATION_ID: 'dm-1',
    X_SELENIUM_CAPABILITIES_JSON: JSON.stringify({ 'goog:chromeOptions': { args: ['--window-size=1920,1080'] } })
  });
  const client = new SeleniumXClient({ logger: { info() {}, warn() {} }, selenium: config.x.selenium });

  assert.deepEqual(client.capabilities()['goog:chromeOptions'].args, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080'
  ]);
});

test('SeleniumXClient rejects malformed capabilities JSON with details', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CHANNEL_ID: 'channel-1',
    X_CLIENT_MODE: 'selenium',
    X_DM_CONVERSATION_ID: 'dm-1',
    X_SELENIUM_CAPABILITIES_JSON: '[]'
  });
  const client = new SeleniumXClient({ logger: { info() {}, warn() {} }, selenium: config.x.selenium });

  assert.throws(() => client.capabilities(), /X_SELENIUM_CAPABILITIES_JSON must be a valid JSON object: not an object/);
});

test('SeleniumXClient marks transient WebDriver errors retryable', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return Response.json({ value: { error: 'stale element reference', message: 'DOM changed' } }, { status: 500 });
    }
    return Response.json({ value: 'ok' });
  };

  try {
    const client = new SeleniumXClient({
      logger: { info() {}, warn() {} },
      selenium: loadConfig({
        DISCORD_TOKEN: 'discord-token',
        DISCORD_CHANNEL_ID: 'channel-1',
        X_CLIENT_MODE: 'selenium',
        X_DM_CONVERSATION_ID: 'dm-1',
        X_SELENIUM_REMOTE_URL: 'http://webdriver.test/wd/hub'
      }).x.selenium
    });

    assert.equal(await client.webdriver('GET', '/status'), 'ok');
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SeleniumXClient logs and clears session when close fails', async () => {
  const originalFetch = globalThis.fetch;
  const warnings = [];
  globalThis.fetch = async () => Response.json({ value: { error: 'invalid session id', message: 'already gone' } }, { status: 404 });

  try {
    const client = new SeleniumXClient({
      logger: { info() {}, warn(payload, message) { warnings.push({ payload, message }); } },
      selenium: loadConfig({
        DISCORD_TOKEN: 'discord-token',
        DISCORD_CHANNEL_ID: 'channel-1',
        X_CLIENT_MODE: 'selenium',
        X_DM_CONVERSATION_ID: 'dm-1',
        X_SELENIUM_REMOTE_URL: 'http://webdriver.test/wd/hub'
      }).x.selenium
    });
    client.sessionId = 'session-1';

    await client.close();

    assert.equal(client.sessionId, null);
    assert.equal(warnings[0].message, 'failed to close Selenium WebDriver session gracefully');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SeleniumXClient sends DMs through WebDriver protocol', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    if (request.url.endsWith('/session') && request.method === 'POST') {
      return Response.json({ value: { sessionId: 'session-1' } });
    }
    if (request.url.endsWith('/url')) return Response.json({ value: null });
    if (request.url.endsWith('/element') && request.body?.value === '[data-testid="dmComposerTextInput"]') {
      return Response.json({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'input-1' } });
    }
    if (request.url.endsWith('/element') && request.body?.value === '[data-testid="dmComposerSendButton"]') {
      return Response.json({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'send-1' } });
    }
    if (request.url.endsWith('/click') || request.url.endsWith('/value')) return Response.json({ value: null });
    return Response.json({ value: { error: 'unknown command', message: request.url } }, { status: 500 });
  };

  try {
    const client = new SeleniumXClient({
      logger: { info() {}, warn() {} },
      selenium: loadConfig({
        DISCORD_TOKEN: 'discord-token',
        DISCORD_CHANNEL_ID: 'channel-1',
        X_CLIENT_MODE: 'selenium',
        X_DM_CONVERSATION_ID: 'dm-1',
        X_SELENIUM_REMOTE_URL: 'http://webdriver.test/wd/hub'
      }).x.selenium
    });

    const result = await client.sendDm('dm-1', 'hello from selenium');

    assert.match(result.id, /^selenium-sent:/);
    assert.ok(requests.some((request) => request.url.endsWith('/url') && request.body.url === 'https://x.com/messages/dm-1'));
    assert.ok(requests.some((request) => request.url.endsWith('/value') && request.body.text === 'hello from selenium'));
    assert.ok(requests.some((request) => request.url.endsWith('/click')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
