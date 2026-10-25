(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "omniroute-chat.v1";
  const MAX_ATTACHMENTS = 5;
  const MAX_TEXT_BYTES = 200 * 1024;
  const MAX_IMAGE_EDGE = 1600;

  const els = {
    app: $("app"),
    chatList: $("chatList"),
    messages: $("messages"),
    empty: $("empty"),
    input: $("input"),
    composer: $("composer"),
    sendBtn: $("sendBtn"),
    stopBtn: $("stopBtn"),
    attachBtn: $("attachBtn"),
    fileInput: $("fileInput"),
    attachments: $("attachments"),
    modelSelect: $("modelSelect"),
    status: $("status"),
    settings: $("settings"),
    settingsForm: $("settingsForm"),
    systemPrompt: $("systemPrompt"),
    temperature: $("temperature"),
    tempOut: $("tempOut"),
    useTemp: $("useTemp"),
    connection: $("connection"),
    baseUrl: $("baseUrl"),
    apiKey: $("apiKey"),
  };

  // ---------- State ----------
  const defaultState = () => ({
    chats: [],
    activeId: null,
    model: "",
    settings: { systemPrompt: "", temperature: 0.7, useTemp: false },
    connection: { baseUrl: "", apiKey: "" },
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        settings: { ...defaultState().settings, ...(parsed.settings || {}) },
        connection: { ...defaultState().connection, ...(parsed.connection || {}) },
      };
    } catch {
      return defaultState();
    }
  }

  let state = load();
  let pending = []; // attachments waiting to be sent
  let abortCtl = null;
  let streaming = false;
  // "proxy": this page is served by server.js, which holds the key.
  // "direct": static hosting (e.g. GitHub Pages); the browser calls OmniRoute itself.
  let mode = "direct";

  async function detectMode() {
    try {
      const res = await fetch("api/health", { cache: "no-store" });
      if (res.ok && (await res.json()).ok === true) return "proxy";
    } catch {
      /* no proxy available */
    }
    return "direct";
  }

  function baseUrl() {
    return state.connection.baseUrl.trim().replace(/\/+$/, "");
  }

  function endpoint(kind) {
    if (mode === "proxy") return kind === "models" ? "api/models" : "api/chat";
    return `${baseUrl()}/v1/${kind === "models" ? "models" : "chat/completions"}`;
  }

  function authHeaders(json) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    const key = state.connection.apiKey.trim();
    if (mode === "direct" && key) headers.Authorization = `Bearer ${key}`;
    return headers;
  }

  function connectionProblem() {
    if (mode === "proxy") return "";
    const raw = baseUrl();
    if (!raw) return "Open Settings and enter your OmniRoute URL to get started.";
    let url;
    try {
      url = new URL(raw);
    } catch {
      return "The OmniRoute URL in Settings is not valid.";
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (location.protocol === "https:" && url.protocol === "http:" && !local) {
      return "This page uses HTTPS, so browsers block an http:// OmniRoute address. Use an https:// URL.";
    }
    return "";
  }

  function networkMessage() {
    return mode === "direct"
      ? `Could not reach OmniRoute at ${baseUrl()}. Check the URL, that it is online, and that it allows browser (CORS) requests.`
      : "Could not reach the server.";
  }

  function openSettings() {
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.tempOut.textContent = state.settings.temperature;
    els.useTemp.checked = state.settings.useTemp;
    els.baseUrl.value = state.connection.baseUrl;
    els.apiKey.value = state.connection.apiKey;
    els.connection.classList.toggle("hidden", mode !== "direct");
    if (typeof els.settings.showModal === "function") els.settings.showModal();
    else els.settings.setAttribute("open", "");
    els.app.classList.remove("sidebar-open");
  }

  function ensureConnected() {
    const problem = connectionProblem();
    if (!problem) return true;
    setStatus(problem, true);
    if (!baseUrl() && mode === "direct") openSettings();
    return false;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      // Most likely over quota because of images: drop stored image data and retry.
      for (const chat of state.chats) for (const m of chat.messages) if (m.images?.length) m.images = [];
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        setStatus("Storage was full, so saved images were removed from history.", true);
      } catch {
        setStatus("Could not save chat history in this browser.", true);
      }
    }
  }

  const uid = () =>
    (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;

  function setStatus(text, isError = false) {
    els.status.textContent = text || "";
    els.status.classList.toggle("error", Boolean(isError));
  }

  // ---------- Markdown ----------
  if (window.marked) marked.setOptions({ gfm: true, breaks: true });
  if (window.DOMPurify) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  function renderMarkdown(el, text) {
    if (window.marked && window.DOMPurify) {
      el.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
      el.querySelectorAll("pre").forEach((pre) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-code";
        btn.textContent = "Copy";
        btn.addEventListener("click", () => {
          copyText(pre.querySelector("code")?.textContent || pre.textContent || "");
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        });
        pre.appendChild(btn);
      });
    } else {
      // Markdown libraries failed to load (offline?): show plain text safely.
      el.textContent = text || "";
      el.style.whiteSpace = "pre-wrap";
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
  }

  // ---------- Rendering ----------
  function renderSidebar() {
    els.chatList.textContent = "";
    const chats = [...state.chats].sort((a, b) => b.updated - a.updated);
    for (const chat of chats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === state.activeId ? " active" : "");
      item.tabIndex = 0;
      item.setAttribute("role", "button");

      const title = document.createElement("span");
      title.className = "chat-title";
      title.textContent = chat.title;

      const del = document.createElement("button");
      del.className = "chat-del";
      del.type = "button";
      del.setAttribute("aria-label", `Delete chat ${chat.title}`);
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(chat.id);
      });

      const open = () => selectChat(chat.id);
      item.addEventListener("click", open);
      item.addEventListener("keydown", (e) => {
        if (e.target === item && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      });
      item.append(title, del);
      els.chatList.appendChild(item);
    }
  }

  function buildMessage(m, index, isLast) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${m.role}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (m.role === "user") {
      if (m.images?.length) {
        const imgs = document.createElement("div");
        imgs.className = "msg-images";
        for (const src of m.images) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "Attached image";
          imgs.appendChild(img);
        }
        wrap.appendChild(imgs);
      }
      if (m.files?.length) {
        const tags = document.createElement("div");
        for (const f of m.files) {
          const tag = document.createElement("span");
          tag.className = "file-tag";
          tag.textContent = `📄 ${f.name}`;
          tags.appendChild(tag);
        }
        wrap.appendChild(tags);
      }
      if (m.content) {
        bubble.textContent = m.content;
        wrap.appendChild(bubble);
      }
    } else {
      bubble.classList.add("md");
      renderMarkdown(bubble, m.content);
      wrap.appendChild(bubble);

      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        copyText(m.content);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      actions.appendChild(copy);
      if (isLast) {
        const regen = document.createElement("button");
        regen.type = "button";
        regen.textContent = "Regenerate";
        regen.addEventListener("click", regenerate);
        actions.appendChild(regen);
      }
      wrap.appendChild(actions);
    }
    return { wrap, bubble };
  }

  function renderMessages() {
    const chat = activeChat();
    els.messages.querySelectorAll(".msg").forEach((n) => n.remove());
    const has = chat && chat.messages.length > 0;
    els.empty.classList.toggle("hidden", Boolean(has));
    if (!has) return;
    chat.messages.forEach((m, i) => {
      const { wrap } = buildMessage(m, i, i === chat.messages.length - 1 && m.role === "assistant");
      els.messages.appendChild(wrap);
    });
    scrollToBottom(true);
  }

  function nearBottom() {
    const el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }
  function scrollToBottom(force = false) {
    if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderAttachments() {
    els.attachments.textContent = "";
    pending.forEach((a, i) => {
      const box = document.createElement("div");
      box.className = "attachment";
      if (a.kind === "image") {
        const img = document.createElement("img");
        img.src = a.dataUrl;
        img.alt = "";
        box.appendChild(img);
      }
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = a.name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.setAttribute("aria-label", `Remove ${a.name}`);
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        pending.splice(i, 1);
        renderAttachments();
      });
      box.append(name, rm);
      els.attachments.appendChild(box);
    });
  }

  function setStreaming(on) {
    streaming = on;
    els.sendBtn.classList.toggle("hidden", on);
    els.stopBtn.classList.toggle("hidden", !on);
  }

  // ---------- Chats ----------
  function newChat() {
    const chat = { id: uid(), title: "New chat", messages: [], updated: Date.now() };
    state.chats.unshift(chat);
    state.activeId = chat.id;
    save();
    return chat;
  }

  function selectChat(id) {
    if (streaming) abortCtl?.abort();
    state.activeId = id;
    save();
    renderSidebar();
    renderMessages();
    els.app.classList.remove("sidebar-open");
    els.input.focus();
  }

  function deleteChat(id) {
    if (id === state.activeId && streaming) abortCtl?.abort();
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.activeId === id) state.activeId = state.chats[0]?.id || null;
    save();
    renderSidebar();
    renderMessages();
  }

  // ---------- API ----------
  function toApiMessage(m) {
    if (m.role !== "user" || (!m.images?.length && !m.files?.length)) {
      return { role: m.role, content: m.content };
    }
    let text = m.content || "";
    for (const f of m.files || []) {
      text += `\n\n--- Attached file: ${f.name} ---\n${f.text}\n--- End of ${f.name} ---`;
    }
    if (!m.images?.length) return { role: "user", content: text.trim() };
    const parts = [];
    if (text.trim()) parts.push({ type: "text", text: text.trim() });
    for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
    return { role: "user", content: parts };
  }

  async function generate(chat) {
    const model = els.modelSelect.value || state.model;
    if (!model) {
      setStatus("Choose a model first.", true);
      return;
    }

    const assistant = { role: "assistant", content: "" };
    const history = chat.messages.map(toApiMessage);
    chat.messages.push(assistant);
    renderMessages();

    const { wrap, bubble } = (() => {
      const nodes = els.messages.querySelectorAll(".msg");
      const last = nodes[nodes.length - 1];
      return { wrap: last, bubble: last.querySelector(".bubble") };
    })();
    wrap.querySelector(".msg-actions")?.remove();
    bubble.classList.add("cursor");

    const messages = [];
    if (state.settings.systemPrompt.trim()) messages.push({ role: "system", content: state.settings.systemPrompt.trim() });
    messages.push(...history);

    const body = { model, messages };
    if (state.settings.useTemp) body.temperature = Number(state.settings.temperature);

    abortCtl = new AbortController();
    setStreaming(true);
    setStatus("Thinking…");

    let frame = 0;
    const paint = () => {
      frame = 0;
      renderMarkdown(bubble, assistant.content);
      bubble.classList.add("cursor");
      scrollToBottom();
    };

    try {
      const res = await fetch(endpoint("chat"), {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortCtl.signal,
      });
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const data = await res.json();
          if (data?.error?.message) message = data.error.message;
        } catch { /* keep generic */ }
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (evt) => {
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.error) throw new Error(json.error.message || "The model returned an error");
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            assistant.content += delta;
            if (!frame) frame = requestAnimationFrame(paint);
          }
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          handleEvent(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!assistant.content) throw new Error("The model returned an empty response.");
      setStatus("");
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus(assistant.content ? "Stopped." : "");
      } else if (err.name === "TypeError") {
        setStatus(networkMessage(), true);
      } else {
        setStatus(err.message || "Something went wrong.", true);
      }
      if (!assistant.content) chat.messages.pop();
    } finally {
      if (frame) cancelAnimationFrame(frame);
      abortCtl = null;
      setStreaming(false);
      chat.updated = Date.now();
      save();
      renderSidebar();
      if (state.activeId === chat.id) renderMessages();
    }
  }

  async function send() {
    if (streaming) return;
    const text = els.input.value.trim();
    if (!text && !pending.length) return;
    if (!ensureConnected()) return;

    const chat = activeChat() || newChat();
    const msg = {
      role: "user",
      content: text,
      images: pending.filter((a) => a.kind === "image").map((a) => a.dataUrl),
      files: pending.filter((a) => a.kind === "text").map((a) => ({ name: a.name, text: a.text })),
    };
    chat.messages.push(msg);
    if (chat.title === "New chat") {
      chat.title = (text || msg.files[0]?.name || "Image chat").replace(/\s+/g, " ").slice(0, 48);
    }
    chat.updated = Date.now();
    pending = [];
    els.input.value = "";
    autoresize();
    renderAttachments();
    save();
    renderSidebar();
    await generate(chat);
  }

  async function regenerate() {
    const chat = activeChat();
    if (!chat || streaming || !ensureConnected()) return;
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") chat.messages.pop();
    if (!chat.messages.length) return;
    await generate(chat);
  }

  // ---------- Models ----------
  async function loadModels() {
    try {
      const problem = connectionProblem();
      if (problem) throw new Error(problem);
      const res = await fetch(endpoint("models"), { headers: authHeaders(false) });
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        const hint = res.status === 401 ? " Check the API key in Settings." : "";
        throw new Error((data?.error?.message || `Request failed (${res.status}).`) + hint);
      }
      const ids = (data.data || []).map((m) => m.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
      if (!ids.length) throw new Error("OmniRoute returned no models. Connect a provider in its dashboard.");
      els.modelSelect.textContent = "";
      for (const id of ids) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        els.modelSelect.appendChild(opt);
      }
      if (ids.includes(state.model)) els.modelSelect.value = state.model;
      state.model = els.modelSelect.value;
      save();
      setStatus("");
    } catch (err) {
      els.modelSelect.textContent = "";
      const opt = document.createElement("option");
      opt.value = state.model || "";
      opt.textContent = state.model || "No models available";
      els.modelSelect.appendChild(opt);
      setStatus(err.name === "TypeError" ? networkMessage() : err.message, true);
    }
  }

  // ---------- Attachments ----------
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  async function shrinkImage(file) {
    const original = await readAsDataURL(file);
    if (/svg|gif/.test(file.type)) return original;
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = original;
      });
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 800 * 1024) return original;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      return original;
    }
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      if (pending.length >= MAX_ATTACHMENTS) {
        setStatus(`You can attach up to ${MAX_ATTACHMENTS} files per message.`, true);
        break;
      }
      try {
        if (file.type.startsWith("image/")) {
          pending.push({ kind: "image", name: file.name, dataUrl: await shrinkImage(file) });
        } else {
          let text = await file.text();
          if (text.includes("\u0000")) {
            setStatus(`${file.name} looks like a binary file and was skipped.`, true);
            continue;
          }
          if (new Blob([text]).size > MAX_TEXT_BYTES) {
            text = text.slice(0, MAX_TEXT_BYTES) + "\n[…truncated]";
            setStatus(`${file.name} was truncated to 200 KB.`, true);
          }
          pending.push({ kind: "text", name: file.name, text });
        }
      } catch {
        setStatus(`Could not read ${file.name}.`, true);
      }
    }
    renderAttachments();
  }

  // ---------- Composer ----------
  function autoresize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
  }

  els.input.addEventListener("input", autoresize);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  els.input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  els.stopBtn.addEventListener("click", () => abortCtl?.abort());
  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    addFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  $("suggestions").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    els.input.value = chip.textContent;
    autoresize();
    els.input.focus();
  });

  // ---------- Sidebar / model / settings ----------
  $("newChat").addEventListener("click", () => {
    if (streaming) abortCtl?.abort();
    const current = activeChat();
    if (!current || current.messages.length) newChat();
    renderSidebar();
    renderMessages();
    els.app.classList.remove("sidebar-open");
    els.input.focus();
  });
  $("menuBtn").addEventListener("click", () => els.app.classList.toggle("sidebar-open"));
  $("scrim").addEventListener("click", () => els.app.classList.remove("sidebar-open"));

  els.modelSelect.addEventListener("change", () => {
    state.model = els.modelSelect.value;
    save();
  });

  $("openSettings").addEventListener("click", openSettings);
  els.temperature.addEventListener("input", () => (els.tempOut.textContent = els.temperature.value));
  $("closeSettings").addEventListener("click", () => els.settings.close());
  els.settingsForm.addEventListener("submit", () => {
    state.settings = {
      systemPrompt: els.systemPrompt.value,
      temperature: Number(els.temperature.value),
      useTemp: els.useTemp.checked,
    };
    if (mode === "direct") {
      state.connection = { baseUrl: els.baseUrl.value.trim(), apiKey: els.apiKey.value.trim() };
    }
    save();
    if (mode === "direct") loadModels();
  });
  $("clearAll").addEventListener("click", () => {
    if (!confirm("Delete all chats from this browser? This cannot be undone.")) return;
    if (streaming) abortCtl?.abort();
    state.chats = [];
    state.activeId = null;
    save();
    renderSidebar();
    renderMessages();
    els.settings.close();
  });

  // ---------- Boot ----------
  renderSidebar();
  renderMessages();
  autoresize();
  (async () => {
    mode = await detectMode();
    els.connection.classList.toggle("hidden", mode !== "direct");
    await loadModels();
    if (mode === "direct" && !baseUrl()) openSettings();
  })();
})();
