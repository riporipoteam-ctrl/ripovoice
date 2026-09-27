/**
 * v7.0: TRULY invisible inter-bot markers.
 *
 * Lesson from v5.7/v6.0: wrapping visible text like [[farewell]] in
 * zero-width SPACES does NOT make it invisible — Discord renders the
 * bracket text plainly (see the 21:47 screenshots: "[[farewell-turn:Pip]]"
 * and "[[share:photo:Pip]]" visible in chat). The whole marker, brackets
 * included, must be encoded AS zero-width characters.
 *
 * Encoding: frame = U+FEFF, payload = each char as 16 bits where
 * U+200B = 0 and U+200C = 1, terminator = U+200D. Discord preserves
 * these characters in message content but renders nothing for them.
 *
 * Marker names (keep to [a-z0-9:-]):
 *   'farewell'            — this ping/message is a GOODBYE, not a summon
 *   'farewell-turn:Bolt'  — Bolt gives the main goodbye speech
 *   'farewell-turn:Pip'   — Pip gives the main goodbye speech
 *   'share:<kind>:<Name>' — carry a share directive (kind = meme|cat|dog|photo)
 *   'thread-invite'       — explicit user invite of buddies into a thread
 */

const ZW_START = '﻿';
const ZW_END = '‍';
const ZW_0 = '​';
const ZW_1 = '‌';

const NAME_RE = /^[a-z0-9-]+(?::[A-Za-z]+)?(?::[A-Za-z]+)?$/;

/** Encode a marker name into an invisible zero-width string. */
function encodeMarker(name) {
  if (!NAME_RE.test(name)) throw new Error(`bad marker name: ${name}`);
  let out = ZW_START;
  for (const ch of name) {
    const bits = ch.charCodeAt(0).toString(2).padStart(16, '0');
    for (const b of bits) out += b === '1' ? ZW_1 : ZW_0;
  }
  return out + ZW_END;
}

/** Decode every marker embedded in text. Returns array of marker names. */
function decodeMarkers(text) {
  const found = [];
  if (typeof text !== 'string' || !text) return found;
  const re = /﻿([​‌]+)‍/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const bits = m[1];
    if (bits.length === 0 || bits.length % 16 !== 0) continue;
    let name = '';
    let ok = true;
    for (let i = 0; i < bits.length; i += 16) {
      let code = 0;
      for (let j = 0; j < 16; j++) {
        code = (code << 1) | (bits[i + j] === ZW_1 ? 1 : 0);
      }
      // sanity: printable ASCII only
      if (code < 32 || code > 126) {
        ok = false;
        break;
      }
      name += String.fromCharCode(code);
    }
    if (ok && NAME_RE.test(name)) found.push(name);
  }
  return found;
}

/** True when text carries the given marker name. */
function hasMarker(text, name) {
  return decodeMarkers(text).includes(name);
}

/** Remove all markers from text (for display / AI prompts / transcripts). */
function stripMarkers(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/﻿[​‌]+‍/g, '').replace(/[ \t]+/g, ' ').trim();
}

/** The farewell-turn marker for a buddy name, or null. */
function farewellTurnFor(text) {
  for (const name of decodeMarkers(text)) {
    const m = /^farewell-turn:(Bolt|Pip)$/.exec(name);
    if (m) return m[1];
  }
  return null;
}

/** The share directive marker { kind, name } or null. */
function shareDirectiveFor(text) {
  for (const name of decodeMarkers(text)) {
    const m = /^share:(meme|cat|dog|photo):(Bolt|Pip)$/.exec(name);
    if (m) return { kind: m[1], name: m[2] };
  }
  return null;
}

// Convenience prebuilt markers (same strings encodeMarker would produce).
const MARK = {
  farewell: () => encodeMarker('farewell'),
  farewellTurn: (name) => encodeMarker(`farewell-turn:${name}`),
  share: (kind, name) => encodeMarker(`share:${kind}:${name}`),
  threadInvite: () => encodeMarker('thread-invite'),
};

module.exports = {
  encodeMarker,
  decodeMarkers,
  hasMarker,
  stripMarkers,
  farewellTurnFor,
  shareDirectiveFor,
  MARK,
  // exported for tests
  _ZW: { START: ZW_START, END: ZW_END, Z0: ZW_0, Z1: ZW_1 },
};
