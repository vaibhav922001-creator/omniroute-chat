# OmniRoute Chat

A clean, Claude-style chat website for your own [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway. Pick any model OmniRoute exposes, chat with streaming replies, attach images and text files, and keep your history in the browser.

It works in two ways:

- **Static site (GitHub Pages).** Open the page, enter your OmniRoute URL and API key in Settings, and chat. Nothing runs on your computer.
- **With the included Node proxy.** `server.js` serves the same page and adds the API key on the server, so it never reaches the browser. The page detects this automatically.

## Features

- Streaming responses with a Stop button and Regenerate
- Model picker filled from OmniRoute's `/v1/models`, so every connected provider and combo shows up
- Markdown rendering (tables, code blocks with Copy buttons), sanitized with DOMPurify
- Attach images (sent as vision input) and text/code files, by button, drag-and-drop or paste
- Saved conversations in `localStorage`, with a sidebar to switch and delete them
- System prompt and optional temperature in Settings
- Light and dark theme, mobile friendly

## Use it on GitHub Pages

1. Push this repo to GitHub.
2. In the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**. The included workflow then deploys the `public/` folder on every push to `main`.
3. Open `https://<your-username>.github.io/<repo-name>/`, click **Settings**, and enter:
   - **URL**: where your OmniRoute is reachable (for example `https://omniroute.example.com`)
   - **API key**: a key created in the OmniRoute dashboard

### Requirements for the static mode

- **OmniRoute must be online** and reachable from your browser. This site is only the chat screen. It cannot run OmniRoute for you.
- The URL must be **HTTPS** (browsers block a GitHub Pages site from calling plain `http://` addresses, except `localhost`).
- OmniRoute must **allow cross-origin (CORS) requests** from `https://<your-username>.github.io`. If you see "Could not reach OmniRoute", check this first, then the URL.
- Your key is stored in this browser's `localStorage` and sent only to the URL you entered. Use a dedicated key, keep usage limits on it, and don't use shared computers. If you want the key kept off the browser entirely, use the Node proxy below.

## Run with the Node proxy (optional)

Node 22+, no dependencies.

```bash
cp .env.example .env      # set OMNIROUTE_API_KEY (and OMNIROUTE_BASE_URL if needed)
npm start                 # http://localhost:3000
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128` | Where OmniRoute is running |
| `OMNIROUTE_API_KEY` | _(empty)_ | Key sent to OmniRoute as a Bearer token |
| `PORT` | `3000` | Port for this website |
| `APP_PASSWORD` | _(empty)_ | If set, the browser asks for this password (any username) |

Anyone who can reach a proxy deployment can spend your OmniRoute quota, so set `APP_PASSWORD` and serve it over HTTPS before exposing it.

## Tests

```bash
npm test
```

Runs the proxy against a mock OmniRoute: model listing, streamed chat, key handling, error passthrough, password gate and path-traversal protection.

## Notes

- Markdown libraries load from the jsDelivr CDN. If they can't load, replies fall back to plain text.
- Large images are downscaled in the browser before sending. Very long histories can fill browser storage, in which case old images are dropped to keep the text.
- Chat history lives only in each visitor's browser.
