# Discord ↔ X/Twitter Group DM Bridge

A production-ready Node.js service that bridges one configured Discord channel with one X/Twitter group DM conversation. It supports two selectable X transports:

1. **Selenium X web UI transport (`X_TRANSPORT=selenium`)** — default path that drives a logged-in Chromium browser and does not require the paid X Direct Message API.
2. **Official X API transport (`X_TRANSPORT=api`)** — optional path for deployments that have an X developer app/account tier with Direct Message API access.

Both modes reuse the same Discord bridge, SQLite dedupe/mapping store, structured logs, retry behavior, health endpoint, Dockerfile, and Docker Compose stack.

> **Important:** Selenium can avoid X API costs, but it is more brittle than the official API. X can change DOM selectors, challenge logins, rate-limit automation, or require manual verification. The official API is more stable but may require paid access and OAuth scopes.

## Transport menu: choose one X mode

Set `X_TRANSPORT` in `.env`:

| Choice | Set this | Best for | Required X settings |
| --- | --- | --- | --- |
| **Selenium browser automation** | `X_TRANSPORT=selenium` | Avoiding X API costs; small/private bridge deployments | `X_GROUP_DM_URL`, logged-in browser profile or `X_COOKIES_JSON` |
| **Official X API** | `X_TRANSPORT=api` | More stable production deployments that already pay for API DM access | `X_ACCESS_TOKEN`, `X_DM_CONVERSATION_ID`, optional `X_API_BASE_URL` |

If `X_TRANSPORT` is omitted, the service defaults to `selenium`.

## Features

- Discord bot listens to exactly one configured channel.
- X/Twitter group DM bridge in both directions.
- Selectable X transport: Selenium web UI or official X API.
- SQLite persistence for message mappings, cursors, and dedupe event state.
- Echo-loop protection for Discord bot messages, X self messages, and already-bridged message IDs.
- Attachment support:
  - Discord → X: public Discord attachment URLs are appended to the outgoing text.
  - X → Discord: available attachment/media URLs are appended when visible/returned; otherwise a placeholder is posted.
- Retry logic with exponential backoff and jitter for transient send failures.
- Pino structured JSON logs with token/cookie redaction.
- `/healthz` endpoint.
- Dockerfile and `docker-compose.yml` with Chromium, ChromeDriver, persistent SQLite data, and persistent Selenium browser profile data.
- Unit tests for config parsing, dedupe, routing, and renderer behavior.

## Where to run it

For production, run this on an always-on VPS or home server with Docker Compose. A local laptop works for testing, but the bridge stops when the laptop sleeps or changes networks.

Recommended production target:

- Ubuntu VPS with 1 vCPU, 1-2 GB RAM, and 10+ GB disk.
- Docker and Docker Compose plugin.
- Persistent Docker volumes for `/app/data` and `/app/browser-data`.
- Outbound internet access to Discord and `x.com` / X API.

You usually do **not** need to expose the health port publicly. The bridge mainly makes outbound connections. If you expose port `3000`, put it behind a firewall or reverse proxy.

## Prerequisites

Common requirements:

- Node.js 20 or newer for local development.
- Docker for the recommended deployment path.
- A Discord application and bot token.

For `X_TRANSPORT=selenium`:

- An X/Twitter account that is already a member of the target group DM.
- A persistent logged-in X browser session, either by mounting `X_BROWSER_USER_DATA_DIR` or by providing `X_COOKIES_JSON`.

For `X_TRANSPORT=api`:

- An X developer project/app with OAuth 2.0 user-context access to DM read/write APIs.
- An access token for the X user that belongs to the target group DM.
- The target X DM conversation ID.

## Discord Bot Setup

1. Create a Discord application in the Discord Developer Portal.
2. Add a bot user and copy its token into `DISCORD_TOKEN`.
3. Enable the **Message Content Intent** for the bot if your Discord application requires it.
4. Invite the bot to your server with permissions to read and send messages in the target channel.
5. Copy the target channel ID into `DISCORD_CHANNEL_ID`.
6. The bridge ignores all other channels and ignores Discord bot-authored messages to prevent loops.

## X setup option 1: Selenium web UI

Use this mode when you want to avoid the paid X DM API.

1. Set `X_TRANSPORT=selenium`.
2. Log in to the X account that belongs to the group DM.
3. Open the target group DM in a browser and copy the full URL. It should look like `https://x.com/messages/...`.
4. Set `X_GROUP_DM_URL` to that URL.
5. Set `X_SELF_USER_ID` to the X display name or handle as it appears in the DM message list. This lets the bridge avoid echoing messages that it sent itself.
6. Choose one session strategy:
   - **Persistent browser profile, recommended:** keep `X_BROWSER_USER_DATA_DIR=./browser-data` locally or `/app/browser-data` in Docker and log in once with that profile.
   - **Cookie injection:** export the logged-in X cookies and put the JSON array in `X_COOKIES_JSON`.
7. If X changes its DOM, override `X_MESSAGE_SELECTOR`, `X_COMPOSER_SELECTOR`, or `X_SEND_BUTTON_SELECTOR` in `.env`.

### Logging in when using Docker/Selenium

The production container runs Chromium headless by default, so the easiest login path is usually:

1. Run the bridge once locally or in a temporary non-headless environment with the same `browser-data` directory.
2. Complete X login and any 2FA/challenge manually.
3. Stop the temporary run.
4. Start the production container with the same mounted `bridge-browser-data` volume.

Alternatively, use `X_COOKIES_JSON` if your organization has an approved secure way to export and rotate cookies. Treat cookies like passwords.

## X setup option 2: official X API

Use this mode when you have X API DM access and want a more stable integration than browser automation.

1. Set `X_TRANSPORT=api`.
2. Create or open your app in the X Developer Portal.
3. Enable OAuth 2.0 user-context authentication.
4. Request/enable the scopes needed by your app and account tier. At minimum this bridge expects a user-context token with:
   - `dm.read`
   - `dm.write`
   - `users.read`
   - `tweet.read`
5. Complete the OAuth consent flow as the X user that belongs to the target group DM.
6. Set `X_ACCESS_TOKEN` to the resulting user access token.
7. Set `X_DM_CONVERSATION_ID` to the group DM conversation ID.
8. If X changes endpoint hostnames or paths for your access tier, set `X_API_BASE_URL` and adapt `src/xApiClient.js`; all official API access is isolated there.

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Health endpoint port, default `3000`. |
| `LOG_LEVEL` | No | Pino log level, default `info`. |
| `SQLITE_PATH` | No | SQLite database path, default `./data/bridge.sqlite`. |
| `DISCORD_TOKEN` | Yes | Discord bot token. Redacted from logs. |
| `DISCORD_CHANNEL_ID` | Yes | Single Discord channel to bridge. |
| `X_TRANSPORT` | No | `selenium` or `api`; defaults to `selenium`. |
| `X_GROUP_DM_URL` | Selenium only | Full `https://x.com/messages/...` URL for the target group DM. |
| `X_SELF_USER_ID` | Selenium recommended | X display name/handle as rendered in the DM, used to avoid self-echoes. |
| `X_BROWSER_USER_DATA_DIR` | Selenium optional | Persistent Chrome profile directory, default `./browser-data`. |
| `X_BROWSER_HEADLESS` | Selenium optional | `true` by default. Set `false` when doing manual local login. |
| `X_BROWSER_NO_SANDBOX` | Selenium optional | `true` by default for containers. |
| `CHROME_BIN` | Selenium optional | Chromium binary path. Docker defaults to `/usr/bin/chromium`. |
| `X_COOKIES_JSON` | Selenium optional | JSON array/object of X cookies to inject before opening the DM. Keep secret. |
| `X_MESSAGE_SELECTOR` | Selenium optional | CSS selector for message nodes, default `[data-testid="messageEntry"]`. |
| `X_COMPOSER_SELECTOR` | Selenium optional | CSS selector for the DM composer, default `[data-testid="dmComposerTextInput"]`. |
| `X_SEND_BUTTON_SELECTOR` | Selenium optional | CSS selector for the send button, default `[data-testid="dmComposerSendButton"]`. |
| `X_ACCESS_TOKEN` | API only | OAuth 2.0 user-context X access token. Redacted from logs. |
| `X_DM_CONVERSATION_ID` | API only | X group DM conversation ID. |
| `X_API_BASE_URL` | API optional | Default `https://api.x.com/2`. |
| `X_POLL_INTERVAL_MS` | No | X DM poll interval, default `15000`. |
| `X_POLL_LIMIT` | No | Max events considered per poll, default `50`. |
| `X_MAX_ATTACHMENT_LINKS` | No | Max Discord attachment links appended to each X DM, default `4`. |

## Local Development

```bash
npm install
npm test
npm run lint
cp .env.example .env
# edit .env and choose X_TRANSPORT
npm start
```

For first-time local Selenium login, set `X_BROWSER_HEADLESS=false`, start the service, complete the browser login, then stop it and set headless back to `true` if desired.

## Docker Deployment

```bash
cp .env.example .env
# edit .env and choose X_TRANSPORT

docker compose up --build -d
```

SQLite data is stored in the `bridge-data` Docker volume mounted at `/app/data`. The Selenium/Chromium profile is stored in `bridge-browser-data` mounted at `/app/browser-data`; it is harmless but unused when `X_TRANSPORT=api`.

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

- Keep `.env`, `X_ACCESS_TOKEN`, `X_COOKIES_JSON`, SQLite data, and browser profile volumes private; they may contain credentials or message metadata.
- Logs are structured JSON. Known token, cookie, and authorization fields are redacted.
- Selenium mode uses stored DOM-derived IDs. Deleting SQLite or browser data can cause old visible messages to be seen again.
- If X changes selectors in Selenium mode, update the selector env vars before changing bridge logic.
- Discord attachments are represented as links because Selenium message composition and some X API tiers cannot upload arbitrary files in a stable way.
- Running browser automation may violate or be restricted by site policies. Use an account you control and understand the operational risk.

## Test Coverage

The included tests cover:

- X transport config selection.
- Dedupe decisions.
- Self-message and already-mapped skip behavior.
- Discord → X routing.
- X → Discord routing.
- Target-send failure dedupe reservation release.
- Attachment rendering and placeholder behavior.
