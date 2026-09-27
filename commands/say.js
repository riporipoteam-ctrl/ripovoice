'use strict';

/** /say — speak text out loud in the voice channel. */

const { SlashCommandBuilder } = require('discord.js');
const voice = require('../utils/voice');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Say something out loud in the voice channel')
    .addStringOption((opt) =>
      opt.setName('text').setDescription('What to say').setRequired(true).setMaxLength(500)
    ),
  async execute(interaction) {
    if (!voice.isInVoice()) {
      await interaction.reply({
        content: '👀 I\'m not in a voice channel — run /join first!',
        ephemeral: true,
      });
      return;
    }
    const text = interaction.options.getString('text', true);
    await interaction.deferReply();
    const ok = await voice.speak(text);
    await interaction.editReply(ok ? '🎙️ Said it!' : '😅 Could not say that — try again.');
  },
};
