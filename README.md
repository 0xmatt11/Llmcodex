# Discord ↔ X/Twitter Group DM Bridge

A production-ready Node.js service that bridges one configured Discord channel with one X/Twitter group DM conversation. It is built for long-running deployment with SQLite state, dedupe protection, echo-loop prevention, structured logging, retries, rate-limit handling, a health endpoint, and container support.

## Features

- Discord bot listens to exactly one configured channel.
- X/Twitter DM group chat bridge in both directions.
- OAuth 2.0 user-context bearer token support for X DM read/write access.
- Optional Selenium WebDriver supplement for X web DM scraping and API-send fallback when API access is incomplete or degraded.
- SQLite persistence for message mappings, cursors, and dedupe event state.
- Echo-loop protection for bot/self messages, already-bridged message IDs, and duplicate in-flight events.
- Attachment support:
  - Discord → X: public Discord attachment URLs are appended to the DM text, capped by `X_MAX_ATTACHMENT_LINKS`.
  - X → Discord: attachment URLs are appended when returned by the API; otherwise a placeholder is posted.
- Retry logic with exponential backoff, jitter, and `Retry-After` support for X rate limits/transient failures.
- Pino structured JSON logs with token redaction.
- Discord mention suppression for bridged X messages (`allowedMentions: { parse: [] }`) plus `@` escaping in rendered text.
- `/healthz` endpoint.
- Dockerfile and `docker-compose.yml`.
- Unit tests for dedupe and routing logic.

## Prerequisites

- Node.js 20 or newer.
- A Discord application and bot token.
- An X developer project/app with OAuth 2.0 user-context access to DM read/write APIs.
- A SQLite-compatible persistent volume for production deployments.

## X/Twitter App Setup

1. Create or open your app in the X Developer Portal.
2. Enable OAuth 2.0 user-context authentication.
3. Configure your OAuth callback URL in the portal. This service expects you to provide a valid access token; it does not run the interactive OAuth authorization flow itself.
4. Request/enable the scopes needed by your app and account tier. At minimum this bridge expects a user-context token with:
   - `dm.read`
   - `dm.write`
   - `users.read`
   - `tweet.read`
5. Complete the OAuth consent flow as the X user that belongs to the target group DM.
6. Set `X_ACCESS_TOKEN` to the resulting user access token.
7. Set `X_DM_CONVERSATION_ID` to the group DM conversation ID.
8. If X changes endpoint hostnames or paths for your access tier, set `X_API_BASE_URL` and adapt `src/xClient.js`; all X API access is isolated there.
9. Optional: enable Selenium with `X_SELENIUM_ENABLED=true` when you also need X web DM visibility. Selenium is supplemental: the bridge still uses the official X API for authenticated API calls and can use Selenium as a fallback sender only when `X_SELENIUM_SEND_FALLBACK=true`.

> Production note: prefer a secret manager and a token refresh job for short-lived OAuth access tokens. Do not commit tokens to git or bake them into Docker images.

## Discord Bot Setup

1. Create a Discord application in the Discord Developer Portal.
2. Add a bot user and copy its token into `DISCORD_TOKEN`.
3. Enable the **Message Content Intent** for the bot if your Discord application requires it.
4. Invite the bot to your server with permissions to read and send messages in the target channel.
5. Copy the target channel ID into `DISCORD_CHANNEL_ID`.
6. The bridge ignores all other channels and ignores Discord bot-authored messages to prevent loops.

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | No | Runtime environment. The Docker image sets this to `production`; `.env.example` does the same for compose/local env-file use. |
| `PORT` | No | Health endpoint port, default `3000`. |
| `LOG_LEVEL` | No | Pino log level, default `info`. |
| `SQLITE_PATH` | No | SQLite database path, default `./data/bridge.sqlite`. |
| `BRIDGE_PUBLIC_BASE_URL` | No | Reserved for deployments that expose public bridge URLs. |
| `DISCORD_TOKEN` | Yes | Discord bot token. Redacted from logs. |
| `DISCORD_CHANNEL_ID` | Yes | Single Discord channel to bridge. |
| `X_ACCESS_TOKEN` | Yes | OAuth 2.0 user-context X access token. Redacted from logs. |
| `X_DM_CONVERSATION_ID` | Yes | X group DM conversation ID. |
| `X_API_BASE_URL` | No | Default `https://api.x.com/2`. |
| `X_POLL_INTERVAL_MS` | No | X DM poll interval, default `15000`. |
| `X_POLL_LIMIT` | No | Max events requested per poll, default `50`. |
| `X_MAX_ATTACHMENT_LINKS` | No | Max Discord attachment links appended to each X DM, default `4`. |
| `X_SELENIUM_ENABLED` | No | Enables Selenium WebDriver integration for supplemental X web DM reads, default `false`. |
| `X_SELENIUM_REMOTE_URL` | No | Selenium server URL, default `http://localhost:4444`. |
| `X_SELENIUM_BROWSER` | No | Browser name requested from Selenium, default `chrome`. |
| `X_SELENIUM_HEADLESS` | No | Requests headless browser mode for new Selenium sessions, default `true`. |
| `X_SELENIUM_TIMEOUT_MS` | No | Selenium element wait timeout, default `10000`. |
| `X_SELENIUM_DM_URL` | No | Optional explicit X DM URL to open instead of `https://x.com/messages/{X_DM_CONVERSATION_ID}`. |
| `X_SELENIUM_SEND_FALLBACK` | No | If true, falls back to Selenium web send when the X API send fails, default `false` to avoid accidental duplicate sends. |

## Local Development

```bash
npm install
npm test
npm run lint
npm start
```

The service loads `.env`, opens the SQLite store, starts the health server, logs in the Discord bot, and then polls the configured X DM conversation through the X API. When Selenium is enabled, each X poll is supplemented with events scraped from X web through Selenium WebDriver. Discord messages are bridged from the configured channel as `messageCreate` events arrive.

## Docker Deployment

```bash
cp .env.example .env
# edit .env

docker compose up --build -d
```

SQLite data is stored in the `bridge-data` Docker volume mounted at `/app/data`.

## Health Check

```bash
curl http://localhost:3000/healthz
```

Example response:

```json
{
  "ok": true,
  "discordReady": true,
  "uptimeSeconds": 42
}
```

## Operational Notes

- Keep `.env` and SQLite volumes private; they may contain credentials or message metadata.
- Logs are structured JSON. Known token fields and authorization headers are redacted.
- Rate limits and transient X API/server errors are retried automatically with bounded backoff.
- Message mappings are persisted after successful cross-posts; duplicate in-flight events are reserved before sending and released if the send fails so a later retry can bridge them.
- X DM polling uses a stored cursor named `x_dm_since_id`. The cursor is used only when it looks like a numeric X event ID; invalid stored cursor values are ignored and logged. Deleting the SQLite database can cause old messages to be seen again.
- Bridged X messages are posted to Discord with mentions disabled and `@` characters escaped to reduce accidental pings.
- Discord attachments are represented as links because the X DM API may not accept arbitrary uploaded media for every account/tier/API version.
- Selenium mode requires an external Selenium server/browser that can access X web and is already authenticated (for example through a prepared browser profile/session). X web selectors are best-effort and may need updates when X changes its UI.

## Test Coverage

The included tests cover:

- Dedupe decisions, including reservation release after send failures.
- Self-message and already-mapped skip behavior.
- Discord → X routing.
- X → Discord routing.
- Attachment rendering, placeholder behavior, and Discord mention suppression.
- X client retry behavior for retryable non-JSON responses.
