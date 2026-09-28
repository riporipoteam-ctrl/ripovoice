'use strict';

/**
 * RipoBot v7.0 — free keyless neural TTS via Microsoft Edge's read-aloud
 * endpoint (the same one the Edge browser uses). No API key, no signup,
 * zero spend. Each bot gets its OWN voice:
 *   Bolt    → en-US-ChristopherNeural (young male, +15% rate = energetic)
 *   Pip     → en-US-AriaNeural (warm female, slightly higher pitch = soft)
 *   RipoBot → en-US-DavisNeural (male, easygoing)
 *
 * Pipeline: edge wss (MP3 out) → mpg123-decoder (WASM, pure JS) →
 * resample 24k→48k → opusscript encode (pure JS) → 20ms Opus packets
 * ready for @discordjs/voice. No native modules, no ffmpeg — Space-safe.
 *
 * synthesize(text, who) -> { packets: Buffer[], ms } | null. Never throws.
 */

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { MPEGDecoder } = require('mpg123-decoder');
const OpusScript = require('opusscript');
const { stripMarkers } = require('./markers');

// ---------------------------------------------------------------------------
// Minimal tolerant WebSocket client.
//
// Why not the `ws` package: Microsoft's speech endpoint answers the upgrade
// with `101` + `upgrade: websocket` but `connection: close` (instead of
// `Connection: Upgrade`). That is enough for browsers, but Node's strict HTTP
// parser never emits 'upgrade' for it, so `ws` aborts with
// "Unexpected server response: 101". This client parses the 101 tolerantly
// (only requires the `upgrade: websocket` header) and implements just the
// framing subset we need: send masked text, receive text/binary, ping→pong.
//
// Outbound proxy: this dev sandbox requires an HTTP CONNECT proxy for
// external traffic; the HF Space connects directly. Proxy env vars are
// honored here; direct TLS is used when they're absent.
// ---------------------------------------------------------------------------

function proxyInfo() {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 8080,
      auth: u.username ? `${u.username}:${decodeURIComponent(u.password)}` : null,
    };
  } catch {
    return null;
  }
}

function readHttpHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.off('data', onData);
      const rest = buf.slice(idx + 4);
      if (rest.length) sock.unshift(rest);
      resolve(buf.slice(0, idx).toString('latin1'));
    };
    sock.on('data', onData);
    sock.once('error', (e) => {
      sock.off('data', onData);
      reject(e);
    });
  });
}

/** TCP (+ optional CONNECT proxy) then TLS to host:port. Resolves a TLSSocket. */
function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const proxy = proxyInfo();
    const tlsify = (sock) => {
      const tlsSock = tls.connect(
        {
          socket: sock,
          servername: host,
          ALPNProtocols: ['http/1.1'],
          // A MITM egress proxy presents its own cert; only strict when direct.
          rejectUnauthorized: !proxy,
        },
        () => resolve(tlsSock)
      );
      tlsSock.once('error', reject);
    };
    if (!proxy) {
      const sock = net.connect(port, host, () => tlsify(sock));
      sock.once('error', reject);
      return;
    }
    const sock = net.connect(proxy.port, proxy.host, () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.auth) req += `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n`;
      sock.write(req + '\r\n');
    });
    sock.once('error', reject);
    readHttpHead(sock).then(
      (head) => {
        const status = parseInt(head.split(' ')[1], 10);
        if (status !== 200) {
          sock.destroy();
          reject(new Error(`proxy CONNECT failed: ${status}`));
          return;
        }
        tlsify(sock);
      },
      (err) => {
        sock.destroy();
        reject(err);
      }
    );
  });
}

class MiniWs {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOpcode = 0;
    this.handlers = { message: [], close: [], error: [] };
    this.open = true;
    sock.on('data', (c) => this._onData(c));
    sock.once('close', () => {
      this.open = false;
      this._emit('close');
    });
    sock.once('error', (e) => this._emit('error', e));
  }
  on(evt, fn) {
    if (this.handlers[evt]) this.handlers[evt].push(fn);
    return this;
  }
  _emit(evt, arg) {
    for (const fn of this.handlers[evt] || []) {
      try { fn(arg); } catch { /* listener error */ }
    }
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(32 * 1024 * 1024)) { this.close(); return; }
        len = Number(big);
        off = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buf.length < off + maskBytes + len) return;
      let payload = this.buf.slice(off + maskBytes, off + maskBytes + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        const p = Buffer.alloc(len);
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ mask[i % 4];
        payload = p;
      }
      this.buf = this.buf.slice(off + maskBytes + len);
      if (opcode === 0x8) { this._closeRemote(); return; } // close
      if (opcode === 0x9) { this._sendFrame(0xa, payload); continue; } // ping → pong
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x0) {
        // continuation
        this.frags.push(payload);
        if (fin) {
          const data = Buffer.concat(this.frags);
          this.frags = [];
          this._emit('message', { data, binary: this.fragOpcode === 0x2 });
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this._emit('message', { data: payload, binary: opcode === 0x2 });
        } else {
          this.fragOpcode = opcode;
          this.frags = [payload];
        }
        continue;
      }
      // unknown opcode: ignore
    }
  }
  _sendFrame(opcode, data) {
    if (!this.open) return;
    const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    try {
      this.sock.write(Buffer.concat([header, mask, masked]));
    } catch { /* closed */ }
  }
  sendText(str) {
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }
  _closeRemote() {
    this.open = false;
    try { this.sock.destroy(); } catch { /* noop */ }
  }
  close() {
    if (!this.open) return;
    this.open = false;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.sock.destroy();
    } catch { /* noop */ }
  }
}

/** Full handshake: TLS socket → tolerant WS upgrade → MiniWs. */
async function miniWsConnect(host, path, query) {
  const sock = await connectTls(host, 443);
  const key = crypto.randomBytes(16).toString('base64');
  const req =
    `GET ${path}?${query} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `User-Agent: ${EDGE_UA}\r\n` +
    `Origin: https://www.bing.com\r\n\r\n`;
  const headPromise = readHttpHead(sock);
  sock.write(req);
  const head = await headPromise;
  const lines = head.split('\r\n');
  const status = parseInt((lines[0] || '').split(' ')[1], 10);
  let isWs = false;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c > 0 && lines[i].slice(0, c).trim().toLowerCase() === 'upgrade') {
      if (lines[i].slice(c + 1).trim().toLowerCase() === 'websocket') isWs = true;
    }
  }
  if (status !== 101 || !isWs) {
    try { sock.destroy(); } catch { /* noop */ }
    throw new Error(`ws handshake failed: HTTP ${status}`);
  }
  return new MiniWs(sock);
}

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const SYNTH_TIMEOUT_MS = 20_000;
// Opus packets are encoded/decoded at 48 kHz throughout (see getOpus()).
const SYNTH_SAMPLE_RATE = 48000;

const VOICES = {
  bolt: { voice: 'en-US-ChristopherNeural', rate: '+15%', pitch: '+0Hz' },
  pip: { voice: 'en-US-AriaNeural', rate: '+2%', pitch: '+8Hz' },
  ripobot: { voice: 'en-US-GuyNeural', rate: '+5%', pitch: '+0Hz' },
};

const BOLT_ID = '1553794360829673553';
const PIP_ID = '1553796168356593675';
const RIPOBOT_ID = '1553742796072951898';

/** Sec-MS-GEC token: uppercase hex SHA-256 of (win-ticks-floored-to-5min + token). */
function makeGec() {
  // Windows file time ticks = 100ns intervals since 1601-01-01. Value is
  // ~1.3e17 — beyond float64 precision, so use BigInt (integer math only).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ticks = ((nowSec + 11644473600n) / 300n) * 300n * 10000000n;
  const payload = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
}

function escXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Clean chat text for speech: strip protocol markers, turn mentions into
 * names, drop emojis/URLs/markdown so the voice doesn't read garbage.
 */
function cleanForSpeech(text) {
  let s = stripMarkers(String(text || ''));
  s = s
    .replace(/<@!?(\d+)>/g, (m, id) => {
      if (id === BOLT_ID) return 'Bolt';
      if (id === PIP_ID) return 'Pip';
      if (id === RIPOBOT_ID) return 'RipoBot';
      return 'someone';
    })
    .replace(/<#\d+>/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\|\|/g, '')
    .replace(/[*_~`>#]/g, '')
    // strip emojis (keep it simple: remove surrogate-pair pictographs + misc symbols)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 400);
}

/** Raw edge-tts synthesize: returns concatenated MP3 bytes. */
function edgeSynthesizeMp3(text, voiceCfg) {
  return new Promise((resolve, reject) => {
    const gec = makeGec();
    const query =
      `TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-141.0.3537.57` +
      `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;
    const chunks = [];
    let done = false;
    let client = null;
    const timer = setTimeout(() => finish(new Error('edge-tts timeout')), SYNTH_TIMEOUT_MS);
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (client) client.close(); } catch { /* noop */ }
      if (err) reject(err);
      else resolve(data);
    };

    miniWsConnect('speech.platform.bing.com', '/consumer/speech/synthesize/readaloud/edge/v1', query).then(
      (ws) => {
        if (done) { ws.close(); return; }
        client = ws;
        const stamp = new Date().toUTCString();
        ws.sendText(
          `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                    outputFormat: OUTPUT_FORMAT,
                  },
                },
              },
            })
        );
        const requestId = crypto.randomUUID().replace(/-/g, '');
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voiceCfg.voice}'><prosody rate='${voiceCfg.rate}' pitch='${voiceCfg.pitch}'>` +
          `${escXml(text)}</prosody></voice></speak>`;
        ws.sendText(
          `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n${ssml}`
        );

        ws.on('message', ({ data, binary }) => {
          try {
            if (!binary) {
              const str = data.toString('utf8');
              if (str.includes('Path:turn.end')) finish(null, Buffer.concat(chunks));
              return;
            }
            // Binary frame: 2-byte BE header length, ASCII headers, \r\n\r\n, payload.
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (buf.length < 2) return;
            const headerLen = buf.readUInt16BE(0);
            const headerEnd = 2 + headerLen;
            if (buf.length < headerEnd) return;
            const headers = buf.slice(2, headerEnd).toString('utf8');
            if (headers.includes('Path:audio')) chunks.push(buf.slice(headerEnd));
          } catch { /* keep collecting */ }
        });
        ws.on('error', (err) => finish(err));
        ws.on('close', () => {
          // turn.end normally arrives first; a bare close with audio = accept it.
          if (chunks.length > 0) finish(null, Buffer.concat(chunks));
          else finish(new Error('edge-tts closed with no audio'));
        });
      },
      (err) => finish(err)
    );
  });
}

let _decoder = null;
let _decoderReady = null;
function getDecoder() {
  if (!_decoder) {
    _decoder = new MPEGDecoder();
    _decoderReady = _decoder.ready.catch(() => {});
  }
  return _decoderReady.then(() => _decoder);
}

let _opus = null;
function getOpus() {
  if (!_opus) _opus = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
  return _opus;
}

/** Linear-interp resample mono float32 from 24kHz to 48kHz. */
function resample24kTo48k(input) {
  const outLen = input.length * 2;
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / 2;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** PCM float32 (−1..1) → 20ms Opus packets (48kHz mono, 960 samples/frame). */
function pcmToOpusPackets(pcm48k) {
  const opus = getOpus();
  const packets = [];
  const FRAME = 960;
  for (let off = 0; off + FRAME <= pcm48k.length; off += FRAME) {
    const int16 = Buffer.alloc(FRAME * 2);
    for (let i = 0; i < FRAME; i++) {
      const v = Math.max(-1, Math.min(1, pcm48k[off + i]));
      int16.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    try {
      const pkt = opus.encode(int16, FRAME);
      if (pkt && pkt.length > 0) packets.push(Buffer.from(pkt));
    } catch { /* skip bad frame */ }
  }
  return packets;
}

// Small LRU cache: identical lines don't re-hit the API.
const CACHE = new Map();
const CACHE_MAX = 60;

/**
 * Synthesize chat text into 20ms Opus packets for a bot's voice.
 * who: 'bolt' | 'pip' | 'ripobot'. Returns { packets, ms } or null. Never throws.
 */
async function synthesize(text, who = 'ripobot') {
  try {
    const clean = cleanForSpeech(text);
    if (!clean) return null;
    const voiceCfg = VOICES[who] || VOICES.ripobot;
    const key = `${voiceCfg.voice}|${voiceCfg.rate}|${voiceCfg.pitch}|${clean}`;
    if (CACHE.has(key)) {
      const hit = CACHE.get(key);
      CACHE.delete(key);
      CACHE.set(key, hit); // refresh LRU
      return hit;
    }
    const mp3 = await edgeSynthesizeMp3(clean, voiceCfg);
    if (!mp3 || mp3.length < 100) return null;
    const decoder = await getDecoder();
    let decoded;
    try {
      decoded = decoder.decode(new Uint8Array(mp3));
    } catch {
      return null;
    }
    if (!decoded || decoded.samplesDecoded === 0) return null;
    // Mix to mono if needed, then resample to 48k.
    const ch0 = decoded.channelData[0];
    let mono = ch0;
    if (decoded.channelData.length > 1) {
      const ch1 = decoded.channelData[1];
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < mono.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    }
    const rate = decoded.sampleRate || 24000;
    const pcm48 = rate === 48000 ? mono : rate === 24000 ? resample24kTo48k(mono) : resampleGeneric(mono, rate);
    const packets = pcmToOpusPackets(pcm48);
    if (packets.length === 0) return null;
    const result = { packets, ms: Math.round((pcm48.length / 48000) * 1000) };
    CACHE.set(key, result);
    while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    return result;
  } catch (err) {
    console.error('[edgetts] synthesize failed:', err.message);
    return null;
  }
}

/** Fallback resampler for unexpected rates (linear interp). */
function resampleGeneric(input, fromRate) {
  const ratio = 48000 / fromRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Decode Opus packets (24 kHz mono) into one signed-16 PCM Buffer. */
function packetsToPcm(packets) {
  const decoder = new OpusScript(SYNTH_SAMPLE_RATE, 1);
  const parts = [];
  for (const packet of packets) {
    let pcm;
    try {
      pcm = decoder.decode(packet);
    } catch {
      continue; // skip a bad packet rather than failing the whole line
    }
    if (pcm && pcm.length) parts.push(pcm);
  }
  return Buffer.concat(parts);
}

/** Wrap 16-bit mono PCM @ sampleRate in a minimal WAV header. */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize speech and return a WAV Buffer (24 kHz 16-bit mono) — for file
 * delivery (e.g. /speak's attachment). Returns null on any failure.
 */
async function synthesizeWav(text, who) {
  const synth = await synthesize(text, who);
  if (!synth || !synth.packets.length) return null;
  const pcm = packetsToPcm(synth.packets);
  if (!pcm.length) return null;
  return pcmToWav(pcm, SYNTH_SAMPLE_RATE);
}

module.exports = {
  synthesize,
  synthesizeWav,
  cleanForSpeech,
  VOICES,
  _internals: { makeGec, escXml, resample24kTo48k, pcmToOpusPackets, packetsToPcm, pcmToWav },
};
