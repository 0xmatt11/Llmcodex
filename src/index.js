import 'dotenv/config';
import { BridgeStore } from './store.js';
import { BridgeRouter } from './bridge.js';
import { XClient } from './xClient.js';
import { createDiscordClient } from './discord.js';
import { createHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const store = new BridgeStore(config.sqlitePath);
const discordClient = createDiscordClient();
const xClient = new XClient({ accessToken: config.x.accessToken, apiBaseUrl: config.x.apiBaseUrl, logger });
const router = new BridgeRouter({ store, discordClient, xClient, logger, config });
let polling = false;
let pollTimer;

function isValidXEventId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

async function pollX() {
  if (polling) return;
  polling = true;
  try {
    const storedSinceId = store.getCursor('x_dm_since_id');
    const sinceId = isValidXEventId(storedSinceId) ? storedSinceId : undefined;
    if (storedSinceId && !sinceId) {
      logger.warn({ storedSinceId }, 'ignoring invalid X DM cursor');
    }
    const events = await xClient.listDmEvents(config.x.conversationId, {
      sinceId,
      maxResults: config.x.pollLimit
    });
    const ordered = [...events].reverse();
    for (const event of ordered) {
      await router.bridgeXMessage(event);
    }
    const newest = events[0]?.id ?? events[0]?.dm_event_id;
    if (newest) store.setCursor('x_dm_since_id', newest);
  } catch (error) {
    logger.error({ err: error }, 'failed to poll X DM events');
  } finally {
    polling = false;
  }
}

discordClient.on('ready', () => {
  logger.info({ discordUserId: discordClient.user?.id }, 'Discord bot ready');
});

discordClient.on('messageCreate', async (message) => {
  try {
    await router.bridgeDiscordMessage(message);
  } catch (error) {
    logger.error({ err: error, discordMessageId: message.id }, 'failed to bridge Discord message');
  }
});

const app = createHealthServer({ logger, store, discordClient });
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'health server listening'));

await discordClient.login(config.discord.token);
pollTimer = setInterval(pollX, config.x.pollIntervalMs);
pollX();

async function closeServer() {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(pollTimer);
  try {
    await closeServer();
    discordClient.destroy();
    await xClient.close();
    store.close();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'failed graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
