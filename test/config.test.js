import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const seleniumEnv = {
  DISCORD_TOKEN: 'discord-token',
  DISCORD_CHANNEL_ID: 'channel-1',
  X_GROUP_DM_URL: 'https://x.com/messages/group-1',
  X_SELF_USER_ID: 'bridge-user'
};

const apiEnv = {
  DISCORD_TOKEN: 'discord-token',
  DISCORD_CHANNEL_ID: 'channel-1',
  X_TRANSPORT: 'api',
  X_ACCESS_TOKEN: 'x-access-token',
  X_DM_CONVERSATION_ID: 'dm-1'
};

test('loadConfig defaults to Selenium X transport and requires X group DM URL plus self identity', () => {
  assert.throws(
    () => loadConfig({ DISCORD_TOKEN: 'discord-token', DISCORD_CHANNEL_ID: 'channel-1' }),
    /X_GROUP_DM_URL, X_SELF_USER_ID/
  );
  assert.throws(
    () => loadConfig({
      DISCORD_TOKEN: 'discord-token',
      DISCORD_CHANNEL_ID: 'channel-1',
      X_GROUP_DM_URL: 'https://x.com/messages/group-1'
    }),
    /X_SELF_USER_ID/
  );

  const config = loadConfig(seleniumEnv);

  assert.equal(config.x.transport, 'selenium');
  assert.equal(config.x.conversationId, seleniumEnv.X_GROUP_DM_URL);
  assert.equal(config.x.selenium.groupDmUrl, seleniumEnv.X_GROUP_DM_URL);
  assert.equal(config.x.selenium.selfUserId, 'bridge-user');
  assert.equal(config.x.selenium.headless, true);
  assert.equal(config.x.selenium.messageSelector, '[data-testid="messageEntry"]');
});

test('loadConfig accepts Selenium selector and browser overrides', () => {
  const config = loadConfig({
    ...seleniumEnv,
    X_TRANSPORT: 'selenium',
    X_BROWSER_HEADLESS: 'false',
    X_BROWSER_NO_SANDBOX: 'false',
    X_BROWSER_USER_DATA_DIR: '/tmp/x-profile',
    X_MESSAGE_SELECTOR: '.message',
    X_COMPOSER_SELECTOR: '.composer',
    X_SEND_BUTTON_SELECTOR: '.send',
    X_VISIBLE_MESSAGE_SCAN_LIMIT: '25'
  });

  assert.equal(config.x.transport, 'selenium');
  assert.equal(config.x.selenium.headless, false);
  assert.equal(config.x.selenium.noSandbox, false);
  assert.equal(config.x.selenium.userDataDir, '/tmp/x-profile');
  assert.equal(config.x.selenium.messageSelector, '.message');
  assert.equal(config.x.selenium.composerSelector, '.composer');
  assert.equal(config.x.selenium.sendButtonSelector, '.send');
  assert.equal(config.x.selenium.visibleMessageScanLimit, 25);
});

test('loadConfig supports official X API transport', () => {
  assert.throws(
    () => loadConfig({ DISCORD_TOKEN: 'discord-token', DISCORD_CHANNEL_ID: 'channel-1', X_TRANSPORT: 'api' }),
    /X_ACCESS_TOKEN, X_DM_CONVERSATION_ID/
  );

  const config = loadConfig({ ...apiEnv, X_API_BASE_URL: 'https://api.example.test/2' });

  assert.equal(config.x.transport, 'api');
  assert.equal(config.x.conversationId, 'dm-1');
  assert.equal(config.x.api.accessToken, 'x-access-token');
  assert.equal(config.x.api.conversationId, 'dm-1');
  assert.equal(config.x.api.apiBaseUrl, 'https://api.example.test/2');
});

test('loadConfig rejects unknown X transport mode', () => {
  assert.throws(
    () => loadConfig({ ...seleniumEnv, X_TRANSPORT: 'carrier-pigeon' }),
    /X_TRANSPORT must be either "selenium" or "api"/
  );
});
