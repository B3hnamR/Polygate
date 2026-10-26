#!/usr/bin/env bun
/**
 * proxy.js: runtime-configurable egress proxy.
 *
 * Every outbound request this bridge makes (inference, model discovery, identity
 * sync, self-update) can be routed through an HTTP/HTTPS proxy so upstream sees
 * that proxy's IP instead of this host's. The setting is edited from the panel at
 * `/` and takes effect on the next request: nothing restarts.
 *
 * Protocol: HTTP/HTTPS only. Bun's `fetch` accepts `proxy:` for those schemes and
 * tunnels TLS through CONNECT, so the ClientHello still comes from Bun, and the
 * transport-fingerprint baseline is unchanged. SOCKS5 is rejected by Bun with
 * `UnsupportedProxyProtocol`, so it is refused here with a message that says so
 * instead of failing later inside a request.
 *
 * Credentials live in `<state dir>/proxy.json` and never leave the process:
 * `describe()` is the only view the HTTP panel and `/health` get, and it carries
 * host:port only.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_FILE_NAME = "proxy.json";
const ENV_OVERRIDE = "UPSTREAM_PROXY_URL";

function stateDir() {
  const raw = process.env.OPENCODE_BRIDGE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".opencode-free-bridge");
}

function configFile() {
  return path.join(stateDir(), CONFIG_FILE_NAME);
}

/**
 * Canonical form of a proxy URL, or the reason it was refused.
 *
 * `""` is valid and means "direct": the panel clears the setting with an empty
 * value rather than a separate verb, so both paths share one validator.
 */
function parseProxyUrl(raw) {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!value) return { ok: true, url: "" };

  let u;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "URL proxy tidak valid. Contoh: http://user:pass@host:8080" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      ok: false,
      error:
        `Skema ${u.protocol} tidak didukung. Bun fetch hanya mendukung proxy http:// dan https:// ` +
        "(tunnel CONNECT). SOCKS5 ditolak runtime, jadi tidak bisa dipakai di sini.",
    };
  }
  if (!u.hostname) return { ok: false, error: "Host proxy kosong." };
  if (u.pathname !== "/" || u.search || u.hash) {
    return { ok: false, error: "URL proxy hanya boleh berisi skema, kredensial, host, dan port." };
  }
  // `u.username`/`u.password` stay percent-encoded exactly as the user typed them,
  // which is what Bun expects. Rebuilding avoids the trailing slash `URL`
  // normalization adds, so the stored value matches what the panel shows back.
  const auth = u.username || u.password
    ? `${u.username}${u.password ? `:${u.password}` : ""}@`
    : "";
  const port = u.port ? `:${u.port}` : "";
  return { ok: true, url: `${u.protocol}//${auth}${u.hostname}${port}` };
}

/** `host:port` for display. Credentials are never part of this string. */
function displayHost(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "configured";
  }
}

let current = { url: "", source: "none", error: null };

function loadFromDisk() {
  const env = (process.env[ENV_OVERRIDE] || "").trim();
  if (env) {
    const parsed = parseProxyUrl(env);
    if (parsed.ok) {
      current = { url: parsed.url, source: "env", error: null };
      return current;
    }
    current = { url: "", source: "env", error: `${ENV_OVERRIDE}: ${parsed.error}` };
    return current;
  }
  let raw = null;
  try {
    raw = fs.readFileSync(configFile(), "utf8");
  } catch {
    current = { url: "", source: "none", error: null };
    return current;
  }
  try {
    const parsed = parseProxyUrl(JSON.parse(raw).url);
    if (!parsed.ok) throw new Error(parsed.error);
    current = { url: parsed.url, source: "file", error: null };
  } catch (err) {
    // A corrupt file must not stop the bridge from starting. Direct egress is
    // the safe fallback, and `error` surfaces the reason in the panel.
    current = { url: "", source: "none", error: `proxy.json tidak terbaca: ${err.message}` };
  }
  return current;
}

function getProxyUrl() {
  return current.url;
}

function describe() {
  return {
    mode: current.url ? "proxy" : "direct",
    proxy: displayHost(current.url),
    hasCredentials: current.url ? /\/\/[^/@]+@/.test(current.url) : false,
    source: current.source,
    locked: current.source === "env",
    configPath: configFile(),
    error: current.error,
  };
}

/**
 * Persist a new setting. `raw` may be empty to go back to direct egress.
 *
 * `UPSTREAM_PROXY_URL` is an operator override, so a runtime edit is refused
 * instead of silently losing to the environment on the next restart.
 */
function setProxyUrl(raw) {
  if (current.source === "env") {
    return {
      ok: false,
      error: `${ENV_OVERRIDE} diset di environment. Ubah variabel itu lalu restart service.`,
    };
  }
  const parsed = parseProxyUrl(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (!parsed.url) {
    try {
      fs.unlinkSync(configFile());
    } catch (err) {
      if (err.code !== "ENOENT") return { ok: false, error: `Gagal menghapus ${configFile()}: ${err.message}` };
    }
    current = { url: "", source: "none", error: null };
    return { ok: true, ...describe() };
  }

  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), `${JSON.stringify({ url: parsed.url }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // A file created earlier keeps its old mode; chmod so credentials created by
    // an older release are not left readable by every local user.
    fs.chmodSync(configFile(), 0o600);
  } catch (err) {
    return { ok: false, error: `Gagal menulis ${configFile()}: ${err.message}` };
  }
  current = { url: parsed.url, source: "file", error: null };
  return { ok: true, ...describe() };
}

/**
 * Add `proxy:` to a fetch init when one is configured. Callers pass their own
 * init untouched, so a request that pins its own proxy keeps it.
 */
function withProxy(init) {
  if (!current.url || (init && init.proxy)) return init;
  return { ...(init || {}), proxy: current.url };
}

/** fetch() through the configured proxy. The single egress entry point. */
function netFetch(url, init) {
  return fetch(url, withProxy(init));
}

/**
 * Prove the proxy works before it becomes the live egress.
 *
 * Two probes: the API the bridge actually calls, and a trace endpoint that
 * answers with the exit IP so the panel can show that egress moved. The API
 * probe is the one that decides `ok`; the IP probe is best-effort.
 */
async function testProxy(url, { timeoutMs = 15000, probeUrl = null } = {}) {
  if (typeof Bun === "undefined") {
    return { ok: false, error: "Proxy egress hanya berjalan di Bun; runtime Node tidak mendukung opsi proxy." };
  }
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.url) return { ok: false, error: "URL proxy kosong." };

  const started = Date.now();
  const exit = await probeExitIp(parsed.url, timeoutMs);
  let res;
  try {
    // Default matches the shipped wire endpoint. The caller passes the live one
    // so a catalog migration does not turn a working proxy into a false failure.
    res = await fetch(probeUrl || "https://opencode.ai/inference/v1/models", {
      proxy: parsed.url,
      headers: { Authorization: "Bearer public" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      exitIp: exit.ip,
      latencyMs: Date.now() - started,
      error: `Tidak bisa menghubungi upstream lewat proxy: ${err.message}`,
    };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return {
      ok: false,
      apiStatus: res.status,
      exitIp: exit.ip,
      latencyMs,
      error:
        res.status === 403
          ? "Proxy tersambung, tapi upstream menolak egress-nya (403). Coba proxy lain."
          : `Proxy tersambung, upstream menjawab ${res.status}.`,
    };
  }
  return { ok: true, apiStatus: res.status, exitIp: exit.ip, latencyMs, exitError: exit.error || null };
}

async function probeExitIp(proxyUrl, timeoutMs) {
  try {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    if (!res.ok) return { ip: null, error: `trace HTTP ${res.status}` };
    const text = await res.text();
    const ip = (text.match(/^ip=(.+)$/m) || [])[1] || null;
    return { ip, error: ip ? null : "trace tanpa field ip" };
  } catch (err) {
    return { ip: null, error: err.message };
  }
}

loadFromDisk();

module.exports = {
  ENV_OVERRIDE,
  configFile,
  parseProxyUrl,
  displayHost,
  getProxyUrl,
  describe,
  setProxyUrl,
  withProxy,
  netFetch,
  testProxy,
  __setForTest(state) {
    current = state;
  },
  __reload: loadFromDisk,
};
