// OmniRoute Chat — tiny dependency-free server.
// Serves the web UI and proxies chat requests to an OmniRoute gateway,
// keeping the API key on the server so it never reaches the browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  /* no .env file — fall back to real environment variables */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 3000);
const OMNIROUTE_BASE_URL = (process.env.OMNIROUTE_BASE_URL || "http://localhost:20128").replace(/\/+$/, "");
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const MAX_BODY_BYTES = 25 * 1024 * 1024; // room for base64 images

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(password, APP_PASSWORD);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function upstreamHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (OMNIROUTE_API_KEY) headers.Authorization = `Bearer ${OMNIROUTE_API_KEY}`;
  return headers;
}

async function handleModels(req, res) {
  try {
    const upstream = await fetch(`${OMNIROUTE_BASE_URL}/v1/models`, {
      headers: upstreamHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return sendJson(res, upstream.status, { error: { message: `OmniRoute returned ${upstream.status} for /v1/models` } });
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  } catch {
    sendJson(res, 502, { error: { message: `Could not reach OmniRoute at ${OMNIROUTE_BASE_URL}. Is it running?` } });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: { message: err.status ? err.message : "Invalid JSON body" } });
  }
  if (!payload || typeof payload.model !== "string" || !Array.isArray(payload.messages)) {
    return sendJson(res, 400, { error: { message: "Body must include `model` and `messages`" } });
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(`${OMNIROUTE_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      let message = `OmniRoute returned ${upstream.status}`;
      try {
        const data = await upstream.json();
        if (data?.error?.message) message = String(data.error.message).slice(0, 500);
      } catch {
        /* keep generic message */
      }
      return sendJson(res, upstream.status || 502, { error: { message } });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    Readable.fromWeb(upstream.body)
      .on("error", () => res.end())
      .pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return; // client stopped the stream
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `Could not reach OmniRoute at ${OMNIROUTE_BASE_URL}. Is it running?` } });
    } else {
      res.end();
    }
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="OmniRoute Chat"', "Content-Type": "text/plain" });
    return res.end("Authentication required");
  }
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, upstream: OMNIROUTE_BASE_URL, hasKey: Boolean(OMNIROUTE_API_KEY) });
    }
    if (pathname === "/api/models" && req.method === "GET") return await handleModels(req, res);
    if (pathname === "/api/chat" && req.method === "POST") return await handleChat(req, res);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: { message: "Internal server error" } });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`OmniRoute Chat running at http://localhost:${PORT}`);
  console.log(`Upstream: ${OMNIROUTE_BASE_URL} (${OMNIROUTE_API_KEY ? "API key set" : "no API key"})`);
  if (!APP_PASSWORD) console.log("Tip: set APP_PASSWORD before exposing this app beyond your own machine.");
});
