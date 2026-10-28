# iPhone Duo stock watch

Get a push on your phone the moment an **iPhone Duo** you want is available for **in-store pickup** at an Apple Store near you. When stock appears it's usually gone within a few minutes, so the alert links straight to Apple's buy page.

- Checks every 2–3 minutes (jittered), backing off when Apple pushes back
- Alerts once per appearance, nearest store first, with a link to the buy page
- Sends alerts through **Home Assistant** (companion app, Time Sensitive), **ntfy**, or **Telegram**. With none set up, it shows a macOS notification
- Stops by itself on an end date you choose

US Apple Stores only (LL/A models). Works on macOS; Linux works too, minus the LaunchAgent.

## Requirements

- Node.js 22 or newer (no npm packages needed)
- Google Chrome (or Chromium, Edge, Brave). Apple blocks plain HTTP clients, so the watcher drives a headless Chrome on apple.com
- One alert channel: Home Assistant with the companion app on your iPhone, or the ntfy app, or a Telegram bot

## Quick start

```sh
git clone https://github.com/FlyingViet/iphone-duo-watch.git
cd iphone-duo-watch
npm run setup      # asks what to watch and where to send alerts, tests it, can start it in the background
```

To check it without waiting:

```sh
npm run once        # one check right now: every nearby store and what's in stock
npm run test-alert  # send a test push to every configured channel
npm run status      # background watcher state + last result
```

## What to watch: `config.json`

`npm run setup` writes this for you. To edit it by hand, copy `config.example.json` to `config.json`:

| Field | Example | Meaning |
|---|---|---|
| `location` | `"10001"` | Your ZIP code (required) |
| `maxMiles` | `30` | Ignore stores farther than this |
| `storage` | `["512GB", "1TB"]` | Any of `256GB`, `512GB`, `1TB`, `2TB` |
| `colors` | `["Star White", "Night Sky"]` | One or both |
| `carrier` | `"unlocked"` | `unlocked`, `att`, `t-mobile`, `verizon`. Only changes which buy page the alert opens; carrier models share stock |
| `checkEveryMinutes` | `[2, 3]` | Random interval between checks (or a single number). Going much faster than 2 tends to get rate-limited |
| `realertAfterMinutes` | `20` | If a model disappears and comes back within this window, don't alert again |
| `failAlertAfterMinutes` | `30` | Warn you if Apple has been unreachable this long |
| `endDate` | `"2026-12-31"` | Stop watching after this day. `""` = never |
| `chromePath` | `""` | Leave empty to auto-detect |
| `stateDir` | `"state"` | Log, status and the Chrome profile |
| `launchAgentLabel` | `"local.iphone-duo-watch"` | Name of the macOS background job |

Models covered:

| | Star White | Night Sky |
|---|---|---|
| 256GB | MK1E4LL/A | MK1F4LL/A |
| 512GB | MK1G4LL/A | MK1H4LL/A |
| 1TB | MK1J4LL/A | MK1L4LL/A |
| 2TB | MK1Q4LL/A | MK1R4LL/A |

## Where to send alerts: `.env`

`npm run setup` writes this too, with private file permissions. To fill it in by hand, copy `.env.example` to `.env`. Set at least one channel; if several are set, all of them get the alert.

### Home Assistant (recommended for iPhone)

1. Install the **Home Assistant** app on your iPhone, sign in, and allow notifications (including Time Sensitive).
2. In Home Assistant, open your profile (bottom left) → **Security** → **Long-lived access tokens** → **Create token**.
3. Fill in:

```sh
HA_URL=http://homeassistant.local:8123   # how this computer reaches HA (LAN IP, Nabu Casa URL, …)
HA_TOKEN=eyJhbGciOi...                   # the token from step 2
HA_NOTIFY_SERVICE=mobile_app_your_iphone # your phone's notify service
```

Setup lists the phones it finds, so you can pick yours. To look it up by hand: **Developer tools → Actions**, search `notify.mobile_app`, and use the part after `notify.`.

Stock alerts are sent as **Time Sensitive**, so they get through Focus modes. Tapping one opens the Apple buy page for the model.

### ntfy (no Home Assistant needed)

Install the ntfy app, subscribe to a long, hard-to-guess topic name, and set `NTFY_TOPIC` to the same name. `NTFY_SERVER` defaults to `https://ntfy.sh`; `NTFY_TOKEN` is only for protected self-hosted servers.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and send it any message. Open `https://api.telegram.org/bot<token>/getUpdates` to find your chat ID, then set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

## Running in the background (macOS)

```sh
npm run install-agent    # start now, at every login, and after crashes
npm run uninstall-agent  # stop and remove
```

The watcher removes its own LaunchAgent when `endDate` passes. Logs are in `state/watch.log`.

On Linux, run `npm start` under systemd, tmux, or similar.

## How it works

The watcher opens apple.com in a headless Chrome and calls the same pickup-availability endpoints the store page uses (`/shop/retail/pickup-message`, falling back to `/shop/fulfillment-messages`) for your ZIP code and chosen models. When a model becomes `available` at a store within your radius, it sends one alert, then stays quiet about that store and model until it sells out and comes back.

If Apple returns errors, the watcher reloads the page and backs off (up to 15 minutes between checks). If it can't reach Apple for `failAlertAfterMinutes`, it sends you a warning.

## Notes

- This is an unofficial personal tool. It isn't affiliated with Apple, and Apple can change these endpoints at any time.
- Keep the interval reasonable. Checking too often gets your IP rate-limited (HTTP 541) for a while.
- `config.json`, `.env` and `state/` are gitignored, so your ZIP code and tokens stay out of the repo.

## License

MIT
