#!/usr/bin/env bun
/**
 * panel.js: the browser panel served at `/`.
 *
 * One job: let the operator point the bridge's egress at an HTTP proxy and see
 * whether that proxy actually reaches upstream. Everything the panel draws comes
 * from `proxy.describe()` over JSON; no user-supplied value is interpolated into
 * this HTML, and the client sets every dynamic string with `textContent`.
 *
 * Design direction (my call, no DESIGN.md in this repo): an operations console for
 * a developer running a local bridge. Warm paper and ink, one clay accent reserved
 * for the commit action and the focus ring, system UI type for prose and monospace
 * only where characters are read one by one (a proxy URL). Dials: ENERGY 1,
 * RHYTHM 1, MOTION 1: this is a settings surface, not a landing page.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --paper: #f7f5f1;
  --surface: #ffffff;
  --ink: #1c1a16;
  --muted: #5c574e;
  --rule: #cfc9bf;
  --field: #8d857a;
  --accent: #9a3f10;
  --accent-ink: #ffffff;
  --ok: #2c6a33;
  --bad: #9b2118;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #131211;
    --surface: #1b1a18;
    --ink: #ece7de;
    --muted: #a49c92;
    --rule: #3a3631;
    --field: #7a746a;
    --accent: #e39a63;
    --accent-ink: #1a1208;
    --ok: #7bc48a;
    --bad: #f08c82;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 20px 64px;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 620px; margin: 0 auto; }
header { border-bottom: 1px solid var(--rule); padding-bottom: 16px; margin-bottom: 28px; }
h1 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 6px; letter-spacing: -0.01em; }
.sub { margin: 0; color: var(--muted); font-size: 0.9375rem; }
h2 { font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
section { margin-bottom: 32px; }
.status {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
  padding: 14px 16px; border: 1px solid var(--rule); border-radius: 3px; background: var(--surface);
}
.status .mode { font-weight: 600; }
.status .mode[data-mode="proxy"] { color: var(--ok); }
.status .host { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9375rem; }
.status .note { color: var(--muted); font-size: 0.875rem; width: 100%; }
.field { margin-bottom: 20px; }
label { display: block; font-weight: 600; font-size: 0.9375rem; margin-bottom: 6px; }
input[type="text"] {
  width: 100%; padding: 10px 12px; font-size: 1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--field); border-radius: 3px;
}
input[type="text"]::placeholder { color: var(--muted); opacity: 1; }
.hint { margin: 6px 0 0; font-size: 0.875rem; color: var(--muted); }
.hint code { font-size: 0.8125rem; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
button {
  font: inherit; font-size: 0.9375rem; font-weight: 600;
  padding: 10px 18px; min-height: 44px;
  border: 1px solid var(--field); border-radius: 3px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: 0.55; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.report { margin-top: 20px; font-size: 0.9375rem; }
.report[hidden] { display: none; }
.report .line { margin: 0 0 4px; }
.report .ok { color: var(--ok); font-weight: 600; }
.report .bad { color: var(--bad); font-weight: 600; }
.report .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; font-size: 0.9375rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--muted); font-size: 0.875rem; }
footer a { color: var(--ink); }
@media (max-width: 480px) {
  body { padding: 28px 16px 48px; }
  .actions button { width: 100%; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dd { margin-bottom: 8px; }
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const urlInput = $("proxy-url");
const saveBtn = $("save");
const testBtn = $("test");
const directBtn = $("direct");
const report = $("report");
const form = $("form");

function line(text, cls) {
  const p = document.createElement("p");
  p.className = "line" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

function showReport(nodes) {
  report.replaceChildren(...nodes);
  report.hidden = false;
}

let locked = false;

// Busy disables everything so a second click cannot race the first. Idle
// restores the lock: an env-owned proxy blocks saving, but probing a candidate
// proxy is read-only and stays available.
function setBusy(busy) {
  saveBtn.disabled = busy || locked;
  directBtn.disabled = busy || locked;
  testBtn.disabled = busy;
}

function renderStatus(state) {
  $("mode").textContent = state.mode === "proxy" ? "Lewat proxy" : "Langsung (IP asli)";
  $("mode").dataset.mode = state.mode;
  $("host").textContent = state.proxy || "tidak ada proxy";
  const notes = [];
  if (state.locked) notes.push("Dikunci " + state.source + ": ubah variabel environment lalu restart.");
  if (state.hasCredentials) notes.push("Kredensial tersimpan, tidak ditampilkan.");
  if (state.source === "file") notes.push("Disimpan di " + state.configPath);
  if (state.error) notes.push(state.error);
  $("note").textContent = notes.join(" ");
  $("note").hidden = notes.length === 0;
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

async function load() {
  try {
    const state = await readJson(await fetch("/api/proxy"));
    renderStatus(state);

    locked = state.locked;

    // An env-owned proxy is read-only for saving, but the field stays usable so
    // a candidate can still be probed before the operator edits the service unit.
    saveBtn.disabled = locked;
    directBtn.disabled = locked;
  } catch (err) {
    showReport([line("Gagal memuat status: " + err.message, "bad")]);
  }
}

async function send(path, payload) {
  setBusy(true);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await readJson(res);
  } finally {
    setBusy(false);
  }
}

async function save() {
  const value = urlInput.value;
  try {
    const state = await send("/api/proxy", { url: value });
    renderStatus(state);
    urlInput.value = "";
    showReport([line(state.mode === "proxy" ? "Proxy aktif. Request berikutnya memakai egress ini." : "Proxy dimatikan. Egress kembali langsung.", "ok")]);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
}

saveBtn.addEventListener("click", save);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  save();
});

testBtn.addEventListener("click", async () => {
  const target = urlInput.value.trim();
  if (!target) {
    showReport([line("Isi URL proxy dulu untuk diuji.", "bad")]);
    return;
  }
  showReport([line("Menguji " + target + " …")]);
  try {
    const r = await send("/api/proxy/test", { url: target });
    const nodes = [];
    if (r.ok) {
      nodes.push(line("Proxy menjawab upstream (HTTP " + r.apiStatus + ") dalam " + r.latencyMs + " ms.", "ok"));
      if (r.exitIp) nodes.push(line("IP keluar: " + r.exitIp, "mono"));
      else nodes.push(line("IP keluar tidak terbaca: " + (r.exitError || "tidak diketahui"), "bad"));
    } else {
      nodes.push(line(r.error || "Uji proxy gagal.", "bad"));
      if (r.exitIp) nodes.push(line("IP keluar: " + r.exitIp, "mono"));
    }
    showReport(nodes);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
});

directBtn.addEventListener("click", async () => {
  try {
    const state = await send("/api/proxy", { url: "" });
    renderStatus(state);
    urlInput.value = "";
    showReport([line("Proxy dimatikan. Egress kembali langsung dari IP mesin ini.", "ok")]);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
});

load();
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Full panel document. `description` is `proxy.describe()`; only its scalar
 * fields are read, and they are escaped, so a value from the config file cannot
 * become markup.
 */
function renderPanel(description, { version = "", port = "" } = {}) {
  const state = description || {};
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Proxy egress · opencode-free-bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Proxy egress</h1>
    <p class="sub">Arahkan semua koneksi keluar bridge lewat proxy HTTP, supaya upstream tidak melihat IP mesin ini.</p>
  </header>

  <section aria-labelledby="status-title">
    <h2 id="status-title">Status sekarang</h2>
    <div class="status">
      <span class="mode" id="mode">${escapeHtml(state.mode === "proxy" ? "Lewat proxy" : "Langsung (IP asli)")}</span>
      <span class="host" id="host">${escapeHtml(state.proxy || "tidak ada proxy")}</span>
      <span class="note" id="note" hidden></span>
    </div>
  </section>

  <section aria-labelledby="form-title">
    <h2 id="form-title">Atur proxy</h2>
    <form id="form" novalidate>
      <div class="field">
        <label for="proxy-url">URL proxy</label>
        <input id="proxy-url" name="proxy-url" type="text" inputmode="url" autocomplete="off"
               spellcheck="false" placeholder="http://user:pass@host:8080"
               aria-describedby="url-hint">
        <p class="hint" id="url-hint">Format <code>http://[user:pass@]host:port</code>. Hanya HTTP/HTTPS (tunnel CONNECT). Kosongkan lalu simpan untuk kembali langsung.</p>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="save">Simpan dan pakai</button>
        <button type="button" id="test">Uji koneksi</button>
        <button type="button" id="direct">Matikan proxy</button>
      </div>
      <div class="report" id="report" role="status" aria-live="polite" hidden></div>
    </form>
  </section>

  <section aria-labelledby="endpoint-title">
    <h2 id="endpoint-title">Endpoint klien</h2>
    <dl>
      <dt>Base URL</dt><dd>http://127.0.0.1:${escapeHtml(port || "20129")}/v1</dd>
      <dt>API key</dt><dd>public</dd>
      <dt>Versi</dt><dd>${escapeHtml(version || "")}</dd>
      <dt>Health</dt><dd><a href="/health">/health</a></dd>
    </dl>
  </section>

  <footer>
    Proxy berlaku untuk inference, discovery model, sinkronisasi identity, dan cek update. Perubahan langsung dipakai request berikutnya, tanpa restart.
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderPanel };
