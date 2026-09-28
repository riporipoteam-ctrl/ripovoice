'use strict';

/**
 * /say — speak text out loud.
 * Tries the voice channel first; if live voice fails (this host blocks
 * Discord voice UDP), falls back to posting a TTS voice message instead
 * so the bot can still talk.
 */

const { SlashCommandBuilder } = require('discord.js');
const voice = require('../utils/voice');
const tts = require('../utils/edgetts');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Say something out loud (voice channel, or a voice message)')
    .addStringOption((opt) =>
      opt.setName('text').setDescription('What to say').setRequired(true).setMaxLength(500)
    ),
  async execute(interaction) {
    const text = interaction.options.getString('text', true);
    await interaction.deferReply();

    // Path 1: live voice, if we're actually in a voice channel.
    if (voice.isInVoice()) {
      const saidLive = await voice.speak(text);
      if (saidLive) {
        await interaction.editReply('🎙️ Said it!');
        return;
      }
    }

    // Path 2: voice-message fallback (hosts without voice UDP, like this one).
    const wav = await tts.synthesizeWav(text, 'ripobot');
    if (!wav) {
      await interaction.editReply('😅 Could not generate speech — try again in a bit!');
      return;
    }
    await interaction.editReply({
      content: `🔊 "${text}"`,
      files: [{ attachment: wav, name: 'ripovoice-say.wav' }],
    });
  },
};
