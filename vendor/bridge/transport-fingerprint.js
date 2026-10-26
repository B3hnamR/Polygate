#!/usr/bin/env bun
/**
 * transport-fingerprint.js — record and compare the outbound TLS ClientHello.
 *
 * Why this exists: the free-tier gate checks the transport, not just headers.
 * Measured from one IP in one minute with identical requests:
 *
 *   real CLI v2.0.32 (Bun)   200
 *   bridge on Bun            200 (6/6)
 *   bridge on Node           403 (0/6)
 *   curl, HTTP/1.1 or h2     403
 *
 * The bridge therefore depends on Bun's TLS stack matching the CLI's. Bun 1.4.2
 * (the version bundled in CLI 2.0.32) and 1.4.3 produce identical ClientHellos
 * today, but nothing guarantees that for 1.5. This script makes the drift
 * visible: it opens a TCP listener, points a fetch at it, and parses the
 * ClientHello without any TLS library.
 *
 *   bun transport-fingerprint.js                 print this runtime's fingerprint
 *   bun transport-fingerprint.js --check         exit 1 if it drifted from the baseline
 *   bun transport-fingerprint.js --write-baseline  record the current fingerprint
 *
 * The fingerprint is the cipher list and the extension set + order. The
 * `random` and `key_share` fields differ on every connection by design and are
 * not part of it.
 */
const net = require("net");
const fs = require("fs");
const path = require("path");

const BASELINE = path.join(__dirname, "transport-baseline.json");

/** Parse a TLS ClientHello record. No TLS library: the bytes are the API. */
function parseClientHello(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 43 || buf[0] !== 0x16) {
    throw new Error("not a TLS handshake record");
  }
  let o = 5; // record header: type(1) version(2) length(2)
  if (buf[o] !== 0x01) throw new Error("not a ClientHello");
  o += 4; // handshake type + 3-byte length
  const legacyVersion = buf.readUInt16BE(o);
  o += 2 + 32; // version + random
  if (o >= buf.length) throw new Error("truncated ClientHello");
  o += 1 + buf[o]; // session id
  if (o + 2 > buf.length) throw new Error("truncated ClientHello");
  const csLen = buf.readUInt16BE(o);
  o += 2;
  if (csLen % 2 !== 0 || o + csLen >= buf.length) throw new Error("truncated ClientHello");
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i).toString(16).padStart(4, "0"));
  o += csLen;
  o += 1 + buf[o]; // compression methods
  if (o + 2 > buf.length) throw new Error("truncated ClientHello");
  const extLen = buf.readUInt16BE(o);
  o += 2;
  if (o + extLen > buf.length) throw new Error("truncated ClientHello");
  const extensions = [];
  const end = o + extLen;
  while (o < end) {
    if (o + 4 > end) throw new Error("truncated ClientHello");
    const type = buf.readUInt16BE(o);
    const len = buf.readUInt16BE(o + 2);
    if (o + 4 + len > end) throw new Error("truncated ClientHello");
    extensions.push(type.toString(16).padStart(4, "0"));
    o += 4 + len;
  }
  return {
    legacyVersion: "0x" + legacyVersion.toString(16),
    ciphers,
    extensions,
  };
}

/** Capture this runtime's ClientHello by pointing a fetch at a local listener. */
function capture() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.once("data", (buf) => {
        sock.destroy();
        srv.close();
        try {
          resolve(parseClientHello(buf));
        } catch (err) {
          reject(err);
        }
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      fetch(`https://127.0.0.1:${port}/`, { method: "POST" }).catch(() => {});
      setTimeout(() => {
        try {
          srv.close();
        } catch {}
        reject(new Error("no ClientHello captured within 3s"));
      }, 3000).unref();
    });
  });
}

function describe(fp) {
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  return {
    runtime,
    legacyVersion: fp.legacyVersion,
    cipherCount: fp.ciphers.length,
    extensionCount: fp.extensions.length,
    ciphers: fp.ciphers,
    extensions: fp.extensions,
  };
}

async function main() {
  const fp = await capture();
  const now = describe(fp);
  const wantWrite = process.argv.includes("--write-baseline");
  const wantCheck = process.argv.includes("--check");

  if (wantWrite) {
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log(`baseline written: ${now.cipherCount} ciphers, ${now.extensionCount} extensions (${now.runtime})`);
    return 0;
  }

  if (wantCheck) {
    if (!fs.existsSync(BASELINE)) {
      console.error(`no baseline at ${BASELINE}; run with --write-baseline first`);
      return 2;
    }
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const sameCiphers = JSON.stringify(base.ciphers) === JSON.stringify(now.ciphers);
    const sameExts = JSON.stringify(base.extensions) === JSON.stringify(now.extensions);
    if (sameCiphers && sameExts) {
      console.log(
        `OK: ${now.runtime} matches the baseline (${now.cipherCount} ciphers, ${now.extensionCount} extensions)`
      );
      return 0;
    }
    console.error(`DRIFT: ${now.runtime} no longer matches the baseline (recorded on ${base.runtime})`);
    if (!sameCiphers) {
      console.error(`  ciphers: baseline ${base.cipherCount} → now ${now.cipherCount}`);
      console.error(`    was: ${base.ciphers.join(" ")}`);
      console.error(`    now: ${now.ciphers.join(" ")}`);
    }
    if (!sameExts) {
      console.error(`  extensions: baseline ${base.extensionCount} → now ${now.extensionCount}`);
      console.error(`    was: ${base.extensions.join(" ")}`);
      console.error(`    now: ${now.extensions.join(" ")}`);
    }
    return 1;
  }

  console.log(JSON.stringify(now, null, 2));
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exit(2);
    });
}

module.exports = { parseClientHello, capture, describe };
