import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRouter, renderForDiscord, renderForX, shouldBridge } from '../src/bridge.js';

class MemoryStore {
  constructor() {
    this.events = new Set();
    this.mappings = new Map();
    this.recorded = [];
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

  recordMapping(mapping) {
    this.recorded.push(mapping);
    this.mappings.set(this.key(mapping.source, mapping.sourceMessageId, mapping.target), mapping);
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
