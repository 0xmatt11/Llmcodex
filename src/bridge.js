import { createHash } from 'node:crypto';

export const SOURCE_DISCORD = 'discord';
export const SOURCE_X = 'x';

export function contentHash({ source, id, text, attachments = [] }) {
  return createHash('sha256')
    .update(JSON.stringify({ source, id, text: text ?? '', attachments: attachments.map((a) => a.url ?? a.name ?? '') }))
    .digest('hex');
}

export function normalizeDiscordMessage(message) {
  const attachmentValues = message.attachments?.values ? [...message.attachments.values()] : [];
  const attachments = attachmentValues.map((attachment) => ({
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType
  }));
  const authorName = message.author?.globalName ?? message.author?.username ?? 'Discord user';
  return {
    source: SOURCE_DISCORD,
    id: message.id,
    authorId: message.author?.id,
    authorName,
    text: message.content ?? '',
    attachments,
    createdAt: message.createdAt?.toISOString?.() ?? new Date().toISOString()
  };
}

export function normalizeXMessage(event) {
  const attachments = event.attachments ?? event.attachment_urls ?? [];
  return {
    source: SOURCE_X,
    id: event.id ?? event.dm_event_id,
    authorId: event.sender_id ?? event.sender?.id,
    authorName: event.sender?.username ?? event.sender?.name ?? 'X user',
    text: event.text ?? event.message_create?.message_data?.text ?? '',
    attachments: attachments.map((attachment) => typeof attachment === 'string' ? { url: attachment } : attachment),
    createdAt: event.created_at ?? new Date().toISOString()
  };
}

export function renderForX(message, { maxAttachmentLinks = 4 } = {}) {
  const header = `${message.authorName} from Discord:`;
  const parts = [header, message.text].filter(Boolean);
  const links = message.attachments.slice(0, maxAttachmentLinks).map((attachment) => attachment.url).filter(Boolean);
  if (links.length > 0) parts.push(`Attachments: ${links.join(' ')}`);
  if (message.attachments.length > links.length) {
    parts.push(`[${message.attachments.length - links.length} attachment(s) omitted: no public URL available]`);
  }
  return parts.join('\n').slice(0, 10000);
}

export function renderForDiscord(message) {
  const parts = [`**${escapeDiscord(message.authorName)} from X:**`, escapeDiscord(message.text)].filter(Boolean);
  const links = message.attachments.map((attachment) => attachment.url).filter(Boolean);
  if (links.length > 0) parts.push(`Attachments: ${links.join(' ')}`);
  if (message.attachments.length > links.length) {
    parts.push(`_${message.attachments.length - links.length} attachment(s) unavailable from X API_`);
  }
  return parts.join('\n').slice(0, 2000);
}

export function escapeDiscord(text) {
  return String(text).replaceAll('@', '@\u200b');
}

export function shouldBridge({ store, source, sourceMessageId, target, authorId, selfIds = [] }) {
  if (!sourceMessageId) return { bridge: false, reason: 'missing_source_message_id' };
  if (selfIds.includes(authorId)) return { bridge: false, reason: 'self_message' };
  if (store.getMapping(source, sourceMessageId, target)) return { bridge: false, reason: 'already_mapped' };
  const eventKey = `${source}:${sourceMessageId}:${target}`;
  if (!store.recordEvent(eventKey)) return { bridge: false, reason: 'duplicate_event' };
  return { bridge: true, eventKey };
}

function releaseDedupeReservation(store, eventKey, logger) {
  if (!eventKey || typeof store.releaseEvent !== 'function') return;
  try {
    store.releaseEvent(eventKey);
  } catch (error) {
    logger?.warn({ err: error, eventKey }, 'failed to release dedupe reservation');
  }
}

function hasContent(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

export class BridgeRouter {
  constructor({ store, discordClient, xClient, logger, config }) {
    this.store = store;
    this.discordClient = discordClient;
    this.xClient = xClient;
    this.logger = logger;
    this.config = config;
  }

  async bridgeDiscordMessage(discordMessage) {
    if (discordMessage.channelId !== this.config.discord.channelId) return { skipped: 'wrong_channel' };
    if (discordMessage.author?.bot) return { skipped: 'bot_message' };
    const normalized = normalizeDiscordMessage(discordMessage);
    const decision = shouldBridge({
      store: this.store,
      source: SOURCE_DISCORD,
      sourceMessageId: normalized.id,
      target: SOURCE_X,
      authorId: normalized.authorId,
      selfIds: [this.discordClient.user?.id].filter(Boolean)
    });
    if (!decision.bridge) return { skipped: decision.reason };

    const text = renderForX(normalized, { maxAttachmentLinks: this.config.x.maxAttachmentLinks });
    if (!hasContent(text)) {
      releaseDedupeReservation(this.store, decision.eventKey, this.logger);
      return { skipped: 'empty_message' };
    }

    let sent;
    try {
      sent = await this.xClient.sendDm(this.config.x.conversationId, text);
    } catch (error) {
      releaseDedupeReservation(this.store, decision.eventKey, this.logger);
      throw error;
    }
    this.store.recordMapping({
      source: SOURCE_DISCORD,
      sourceMessageId: normalized.id,
      target: SOURCE_X,
      targetMessageId: sent.id,
      direction: 'discord_to_x',
      contentHash: contentHash(normalized)
    });
    this.logger.info({ discordMessageId: normalized.id, xMessageId: sent.id }, 'bridged Discord message to X DM');
    return { bridged: true, targetMessageId: sent.id };
  }

  async bridgeXMessage(event) {
    const normalized = normalizeXMessage(event);
    const decision = shouldBridge({
      store: this.store,
      source: SOURCE_X,
      sourceMessageId: normalized.id,
      target: SOURCE_DISCORD,
      authorId: normalized.authorId,
      selfIds: [await this.xClient.getAuthenticatedUserId()].filter(Boolean)
    });
    if (!decision.bridge) return { skipped: decision.reason };

    const content = renderForDiscord(normalized);
    if (!hasContent(content)) {
      releaseDedupeReservation(this.store, decision.eventKey, this.logger);
      return { skipped: 'empty_message' };
    }

    let channel;
    let sent;
    try {
      channel = await this.discordClient.channels.fetch(this.config.discord.channelId);
      sent = await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      releaseDedupeReservation(this.store, decision.eventKey, this.logger);
      throw error;
    }
    this.store.recordMapping({
      source: SOURCE_X,
      sourceMessageId: normalized.id,
      target: SOURCE_DISCORD,
      targetMessageId: sent.id,
      direction: 'x_to_discord',
      contentHash: contentHash(normalized)
    });
    this.logger.info({ xMessageId: normalized.id, discordMessageId: sent.id }, 'bridged X DM to Discord');
    return { bridged: true, targetMessageId: sent.id };
  }
}
