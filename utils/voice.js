'use strict';

/**
 * RipoVoice — minimal voice helper.
 * joinVoice / leaveVoice / speak, plus auto-leave after 60s alone.
 * TTS: free keyless Edge neural voices (utils/edgetts.js), Opus-encoded
 * in pure JS (opusscript) — no ffmpeg, no native modules.
 */

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { Readable } = require('stream');
const tts = require('./edgetts');

const VOICE_ID = 'ripobot'; // en-US-GuyNeural — the voice of this bot

const state = {
  connection: null,
  player: null,
  channelId: null,
  queue: [],
  pumping: false,
  aloneTimer: null,
};

function isInVoice() {
  return !!state.connection && !!state.channelId;
}

/** Opus packets → a Readable paced at one packet per 20ms (Discord timing). */
function packetsToStream(packets) {
  let i = 0;
  let timer = null;
  const stream = new Readable({
    read() {},
    destroy(err, cb) {
      if (timer) clearInterval(timer);
      cb(err);
    },
  });
  timer = setInterval(() => {
    if (i >= packets.length) {
      clearInterval(timer);
      timer = null;
      stream.push(null);
      return;
    }
    stream.push(packets[i]);
    i += 1;
  }, 20);
  stream.on('close', () => {
    if (timer) clearInterval(timer);
  });
  return stream;
}

function playPackets(packets) {
  return new Promise((resolve) => {
    if (!state.player || !isInVoice()) return resolve(false);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const safety = setTimeout(() => done(true), packets.length * 20 + 10_000);
    try {
      const resource = createAudioResource(packetsToStream(packets), {
        inputType: StreamType.Opus,
        inlineVolume: false,
      });
      const onIdle = () => {
        clearTimeout(safety);
        state.player.off(AudioPlayerStatus.Idle, onIdle);
        state.player.off('error', onError);
        done(true);
      };
      const onError = (err) => {
        clearTimeout(safety);
        console.error('[voice] player error:', err.message);
        state.player.off(AudioPlayerStatus.Idle, onIdle);
        state.player.off('error', onError);
        done(false);
      };
      state.player.once(AudioPlayerStatus.Idle, onIdle);
      state.player.once('error', onError);
      state.player.play(resource);
    } catch (err) {
      clearTimeout(safety);
      console.error('[voice] play failed:', err.message);
      done(false);
    }
  });
}

async function pumpQueue() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (state.queue.length > 0 && isInVoice()) {
      const { text, resolve } = state.queue.shift();
      let ok = false;
      try {
        const synth = await tts.synthesize(text, VOICE_ID);
        if (synth && synth.packets.length > 0) {
          ok = await playPackets(synth.packets);
        } else {
          console.error('[voice] TTS returned no audio');
        }
      } catch (err) {
        console.error('[voice] speak failed:', err.message);
      }
      try { resolve(ok); } catch { /* noop */ }
    }
  } finally {
    state.pumping = false;
  }
}

/** Queue a spoken line. Resolves true when it finished playing. Never throws. */
function speak(text) {
  return new Promise((resolve) => {
    const clean = tts.cleanForSpeech(text);
    if (!clean || !isInVoice()) return resolve(false);
    if (state.queue.length > 8) state.queue.splice(0, state.queue.length - 8);
    state.queue.push({ text: clean, resolve });
    pumpQueue();
  });
}

/**
 * Join a voice channel. Returns true on success.
 * NOTE: needs outbound UDP (Discord voice ports) — won't work on hosts
 * that block non-web ports (e.g. Hugging Face Spaces free tier).
 */
async function joinVoice(voiceChannel) {
  try {
    if (!voiceChannel || !voiceChannel.guild || !voiceChannel.isVoiceBased?.()) return false;
    const channelId = voiceChannel.id;
    if (state.channelId === channelId && state.connection) return true;
    try {
      const me = voiceChannel.guild.members?.me;
      const perms = me ? voiceChannel.permissionsFor(me) : null;
      if (perms && (!perms.has('Connect') || !perms.has('Speak'))) {
        console.error('[voice] missing Connect/Speak permission');
        return false;
      }
    } catch { /* best-effort; the join fails loudly if needed */ }
    leaveVoice();
    const connection = joinVoiceChannel({
      channelId,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    const player = createAudioPlayer();
    connection.subscribe(player);
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (state.connection === connection) leaveVoice();
    });
    state.connection = connection;
    state.player = player;
    state.channelId = channelId;
    console.log(`[voice] joined ${channelId}`);
    return true;
  } catch (err) {
    console.error('[voice] join failed:', err.message);
    leaveVoice();
    return false;
  }
}

/** Leave the voice channel, stop audio, clear the queue. */
function leaveVoice() {
  try {
    for (const item of state.queue) {
      try { item.resolve(false); } catch { /* noop */ }
    }
    state.queue = [];
    state.pumping = false;
    if (state.aloneTimer) {
      clearTimeout(state.aloneTimer);
      state.aloneTimer = null;
    }
    if (state.player) {
      try { state.player.stop(true); } catch { /* noop */ }
    }
    if (state.connection) {
      try { state.connection.destroy(); } catch { /* noop */ }
    }
  } catch { /* noop */ }
  state.connection = null;
  state.player = null;
  state.channelId = null;
}

/** Auto-leave after 60s alone in the channel (says bye first). */
function watchVoice(client) {
  if (!client || typeof client.on !== 'function') return;
  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const me = client.user?.id;
      if (!me || newState.id !== me || !state.channelId) return;
      const chan = newState.channel || oldState.channel;
      if (!chan || chan.id !== state.channelId) return;
      const humans = chan.members.filter((m) => !m.user.bot).size;
      if (humans === 0 && !state.aloneTimer) {
        state.aloneTimer = setTimeout(() => {
          state.aloneTimer = null;
          if (isInVoice()) {
            console.log('[voice] alone for 60s, leaving');
            speak('looks like everyone left — I\'m heading out too! bye!')
              .finally(() => setTimeout(leaveVoice, 3000));
          }
        }, 60_000);
      } else if (humans > 0 && state.aloneTimer) {
        clearTimeout(state.aloneTimer);
        state.aloneTimer = null;
      }
    } catch (err) {
      console.error('[voice] watch error:', err.message);
    }
  });
}

module.exports = { isInVoice, joinVoice, leaveVoice, speak, watchVoice };
