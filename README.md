# OmniRoute Chat

A clean, Claude-style chat website that runs on top of your own [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway. Pick any model OmniRoute exposes, chat with streaming replies, attach images and text files, and keep your history in the browser.

The browser never sees your API key. A small server-side proxy adds it to each request, and the whole app has **zero npm dependencies** (Node 22+).

## Features

- Streaming responses with a Stop button and Regenerate
- Model picker filled from OmniRoute's `/v1/models`, so every connected provider and combo shows up
- Markdown rendering (tables, code blocks with Copy buttons), sanitized with DOMPurify
- Attach images (sent as vision input) and text/code files, by button, drag-and-drop or paste
- Saved conversations in `localStorage`, with a sidebar to switch and delete them
- System prompt and optional temperature in Settings
- Light and dark theme, mobile friendly
- Optional password protection (`APP_PASSWORD`)

## Quick start

1. Run OmniRoute and connect at least one provider in its dashboard (default `http://localhost:20128`). Create an API key there.
2. Configure and start this app:

```bash
cp .env.example .env      # then edit OMNIROUTE_API_KEY (and OMNIROUTE_BASE_URL if needed)
npm start
```

3. Open http://localhost:3000.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128` | Where OmniRoute is running |
| `OMNIROUTE_API_KEY` | _(empty)_ | Key sent to OmniRoute as a Bearer token |
| `PORT` | `3000` | Port for this website |
| `APP_PASSWORD` | _(empty)_ | If set, the browser asks for this password (any username) |

## Deploying

Anyone who can reach this app can spend your OmniRoute quota, so **set `APP_PASSWORD` and serve it over HTTPS** (for example behind Caddy, nginx or a Cloudflare Tunnel) before exposing it beyond your own machine. OmniRoute itself must be reachable from wherever this server runs.

Chat history lives in each visitor's browser only. Nothing is stored on the server.

## Tests

```bash
npm test
```

Runs the server against a mock OmniRoute: model listing, streamed chat, key handling, error passthrough, password gate and path-traversal protection.

## Notes

- Markdown libraries load from the jsDelivr CDN. If they can't load, replies fall back to plain text.
- Large images are downscaled in the browser before sending. Very long histories can fill browser storage, in which case old images are dropped to keep the text.
