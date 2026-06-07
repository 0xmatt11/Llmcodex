# Discord ↔ X/Twitter Group DM Bridge

A production-ready Node.js service that bridges one configured Discord channel with one X/Twitter group DM conversation using either the official X API or a Selenium/WebDriver browser session. It is built for long-running deployment with SQLite state, dedupe protection, echo-loop prevention, structured logging, retries, rate-limit handling, a health endpoint, and container support.

## Features

- Discord bot listens to exactly one configured channel.
- X/Twitter DM group chat bridge in both directions.
- Selectable X-side transport via `X_CLIENT_MODE=api` or `X_CLIENT_MODE=selenium`; the selected mode is logged at startup.
- OAuth 2.0 user-context bearer token support for X API DM read/write access.
- Selenium/WebDriver support for browser-automated X/Twitter DMs when API access is unavailable.
- SQLite persistence for message mappings, cursors, and dedupe event state.
- Echo-loop protection for bot/self messages, already-bridged message IDs, and duplicate in-flight events.
- Attachment support:
  - Discord → X: public Discord attachment URLs are appended to the DM text, capped by `X_MAX_ATTACHMENT_LINKS`.
  - X → Discord: attachment URLs are appended when returned by the selected X-side transport; otherwise a placeholder is posted.
- Retry logic with exponential backoff, jitter, and `Retry-After` support for X API rate limits/transient failures.
- Pino structured JSON logs with token redaction.
- Discord mention suppression for bridged X messages (`allowedMentions: { parse: [] }`) plus `@` escaping in rendered text.
- `/healthz` endpoint.
- Dockerfile and `docker-compose.yml`.
- Unit tests for dedupe and routing logic.

## Prerequisites

- Node.js 20 or newer.
- A Discord application and bot token.
- For `X_CLIENT_MODE=api`: an X developer project/app with OAuth 2.0 user-context access to DM read/write APIs.
- For `X_CLIENT_MODE=selenium`: a Selenium/WebDriver server with a Chrome or Firefox browser session authenticated to X/Twitter.
- A SQLite-compatible persistent volume for production deployments.

## X/Twitter Mode Selection

Choose the X-side transport with `X_CLIENT_MODE`:

- `api` (default): uses OAuth-authenticated X API endpoints for `/users/me`, DM send, and DM polling. This is the most stable mode when your X developer account has DM API access.
- `selenium`: uses a remote Selenium/WebDriver browser session to open the X/Twitter DM page, scrape visible DM entries, and send messages through the browser UI. Use this when you cannot use the X API, and keep selector variables configurable because X/Twitter UI markup can change.

The application logs the selected mode as `xClientMode` during startup.

## X/Twitter API Setup

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
8. Set `X_CLIENT_MODE=api`.
9. If X changes endpoint hostnames or paths for your access tier, set `X_API_BASE_URL` and adapt the API client in `src/xClient.js`; X access is isolated there.

> Production note: prefer a secret manager and a token refresh job for short-lived OAuth access tokens. Do not commit tokens to git or bake them into Docker images.

## X/Twitter Selenium Setup

1. Run a Selenium/WebDriver server that can start Chrome or Firefox, for example Selenium Grid or a standalone browser container.
2. Make sure the browser session is authenticated to X/Twitter. In practice this usually means mounting a persistent browser profile directory into the Selenium browser and logging in once, or connecting to a remote browser session that already preserves login state.
3. Set `X_CLIENT_MODE=selenium`.
4. Set either `X_DM_CONVERSATION_ID` (the bridge opens `https://x.com/messages/<id>` by default) or `X_SELENIUM_DM_URL` (an exact DM URL to open).
5. Set `X_SELENIUM_REMOTE_URL` to the Selenium/WebDriver endpoint, such as `http://localhost:4444/wd/hub`.
6. Keep the `X_SELENIUM_*_SELECTOR` values in `.env` easy to adjust. They default to current best-effort X/Twitter UI selectors, but browser automation is inherently more brittle than the API and may need selector updates when X changes its UI.

> Selenium note: this implementation uses the standard WebDriver HTTP protocol directly; it does not require a Node Selenium package dependency. Selenium mode can only read messages visible in the loaded conversation and uses synthetic event IDs when the page does not expose stable message IDs.

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
| `X_CLIENT_MODE` | No | X-side transport: `api` (default) or `selenium`. |
| `X_DM_CONVERSATION_ID` | API: yes; Selenium: yes unless `X_SELENIUM_DM_URL` is set | X group DM conversation ID. Selenium mode opens `X_SELENIUM_BASE_URL/messages/<id>` when no exact DM URL is configured. |
| `X_POLL_INTERVAL_MS` | No | X DM poll interval, default `15000`. |
| `X_POLL_LIMIT` | No | Max events requested per poll, default `50`. |
| `X_MAX_ATTACHMENT_LINKS` | No | Max Discord attachment links appended to each X DM, default `4`. |
| `X_ACCESS_TOKEN` | API mode only | OAuth 2.0 user-context X access token. Redacted from logs. |
| `X_API_BASE_URL` | No | API mode base URL, default `https://api.x.com/2`. |
| `X_SELENIUM_REMOTE_URL` | No | Selenium/WebDriver endpoint, default `http://localhost:4444/wd/hub`. |
| `X_SELENIUM_BROWSER` | No | Selenium browser name, default `chrome`; `firefox` is also supported. |
| `X_SELENIUM_HEADLESS` | No | Whether to request a headless browser, default `true`. |
| `X_SELENIUM_PROFILE_DIR` | No | Browser profile directory to pass to Chrome/Firefox; useful for preserving X login state. |
| `X_SELENIUM_BASE_URL` | No | Base URL for Selenium DM URLs, default `https://x.com`. |
| `X_SELENIUM_DM_URL` | Selenium alternative | Exact X/Twitter DM URL; overrides `X_SELENIUM_BASE_URL/messages/<X_DM_CONVERSATION_ID>`. |
| `X_SELENIUM_SELF_USER_ID` | No | Synthetic self user ID used for Selenium echo-loop checks, default `selenium-self`. |
| `X_SELENIUM_*_SELECTOR` | No | CSS selectors for Selenium scraping/sending; see `.env.example` for the full list. |
| `X_SELENIUM_CAPABILITIES_JSON` | No | Extra Selenium capabilities as a JSON object. |

## Local Development

```bash
npm install
npm test
npm run lint
npm start
```

The service loads `.env`, selects the X-side client from `X_CLIENT_MODE`, opens the SQLite store, starts the health server, logs in the Discord bot, and then polls the configured X DM conversation. Discord messages are bridged from the configured channel as `messageCreate` events arrive.

## Docker Deployment

```bash
cp .env.example .env
# edit .env

docker compose up --build -d
```

SQLite data is stored in the `bridge-data` Docker volume mounted at `/app/data`.

For Selenium mode, you can also start the optional Selenium service:

```bash
X_CLIENT_MODE=selenium X_SELENIUM_REMOTE_URL=http://selenium:4444/wd/hub docker compose --profile selenium up --build -d
```

The included Selenium service uses a `selenium-profile` volume mounted at `/home/seluser/profile`; point `X_SELENIUM_PROFILE_DIR` at that path if you want Chrome to reuse the profile.

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
- Rate limits and transient X API/server errors are retried automatically with bounded backoff in API mode. Selenium mode relies on WebDriver/browser waits and configurable selectors.
- Message mappings are persisted after successful cross-posts; duplicate in-flight events are reserved before sending and released if the send fails so a later retry can bridge them.
- X DM polling uses a stored cursor named `x_dm_since_id`. API mode accepts numeric X event IDs; Selenium mode accepts non-empty browser/synthetic event IDs. Invalid stored cursor values are ignored and logged. Deleting the SQLite database can cause old messages to be seen again.
- Bridged X messages are posted to Discord with mentions disabled and `@` characters escaped to reduce accidental pings.
- Discord attachments are represented as links because the X DM API and Selenium browser UI path may not accept arbitrary uploaded media for every account/tier/API version.
- Selenium mode is more brittle than API mode: it depends on an authenticated browser profile, visible conversation history, and selectors that may need updates after X/Twitter UI changes.

## Test Coverage

The included tests cover:

- Dedupe decisions, including reservation release after send failures.
- Self-message and already-mapped skip behavior.
- Discord → X routing.
- X → Discord routing.
- Attachment rendering, placeholder behavior, and Discord mention suppression.
- X client retry behavior for retryable non-JSON responses.
- Configuration and factory selection for API versus Selenium X client modes.
