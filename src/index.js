import 'dotenv/config';
import { BridgeStore } from './store.js';
import { BridgeRouter } from './bridge.js';
import { createXClient } from './xClient.js';
import { createDiscordClient } from './discord.js';
import { createHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const store = new BridgeStore(config.sqlitePath);
const discordClient = createDiscordClient();
const xClient = createXClient({ config, logger });
logger.info({ transport: config.x.transport }, 'selected X bridge transport');
const router = new BridgeRouter({ store, discordClient, xClient, logger, config });
let polling = false;
let pollTimer;

async function pollX() {
  if (polling) return;
  polling = true;
  try {
    const sinceId = store.getCursor('x_dm_since_id');
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

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(pollTimer);
  server.close();
  discordClient.destroy();
  await xClient.close();
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
