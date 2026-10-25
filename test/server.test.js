import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 41901;
const APP_PORT = 41902;
const AUTH_PORT = 41903;
const KEY = "sk-test-key";

let mock;
let seen = [];
const children = [];

function startApp(port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      OMNIROUTE_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      OMNIROUTE_API_KEY: KEY,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("running at") && resolve(child));
    child.on("error", reject);
    setTimeout(() => reject(new Error("server did not start")), 5000);
  });
}

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
      }
      if (req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body);
        if (parsed.model === "bad-model") {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Model not found" } }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const piece of ["Hel", "lo", "!"]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  await startApp(APP_PORT);
  await startApp(AUTH_PORT, { APP_PASSWORD: "hunter2" });
});

after(() => {
  children.forEach((c) => c.kill());
  mock.close();
});

const base = `http://127.0.0.1:${APP_PORT}`;

test("serves the UI", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /OmniRoute Chat/);
});

test("blocks path traversal", async () => {
  const res = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
  assert.notEqual(res.status, 200);
});

test("lists models and attaches the API key server-side", async () => {
  seen = [];
  const res = await fetch(`${base}/api/models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.data.map((m) => m.id), ["model-a", "model-b"]);
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
});

test("streams chat completions through", async () => {
  seen = [];
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.equal(text.match(/"content":"([^"]*)"/g).map((s) => s.slice(11, -1)).join(""), "Hello!");
  assert.match(text, /\[DONE\]/);
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.equal(seen[0].body.stream, true);
});

test("forces stream mode even if the client asks otherwise", async () => {
  seen = [];
  await (
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
  ).text();
  assert.equal(seen[0].body.stream, true);
});

test("passes upstream errors back as JSON", async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bad-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.message, "Model not found");
});

test("rejects malformed requests", async () => {
  const bad = await fetch(`${base}/api/chat`, { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ model: "x" }) });
  assert.equal(missing.status, 400);
});

test("never exposes the API key", async () => {
  const health = await (await fetch(`${base}/api/health`)).text();
  assert.ok(!health.includes(KEY));
  const page = await (await fetch(`${base}/app.js`)).text();
  assert.ok(!page.includes(KEY));
});

test("APP_PASSWORD gates everything", async () => {
  const auth = `http://127.0.0.1:${AUTH_PORT}`;
  assert.equal((await fetch(`${auth}/`)).status, 401);
  assert.equal((await fetch(`${auth}/api/models`)).status, 401);
  const wrong = "Basic " + Buffer.from("me:nope").toString("base64");
  assert.equal((await fetch(`${auth}/api/models`, { headers: { Authorization: wrong } })).status, 401);
  const right = "Basic " + Buffer.from("me:hunter2").toString("base64");
  assert.equal((await fetch(`${auth}/api/models`, { headers: { Authorization: right } })).status, 200);
});

test("reports a clear error when OmniRoute is down", async () => {
  const dead = await startApp(41904, { OMNIROUTE_BASE_URL: "http://127.0.0.1:1" });
  const res = await fetch(`http://127.0.0.1:41904/api/models`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /Could not reach OmniRoute/);
  dead.kill();
});
