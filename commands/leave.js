'use strict';

/** /leave — leave the voice channel. */

const { SlashCommandBuilder } = require('discord.js');
const voice = require('../utils/voice');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel'),
  async execute(interaction) {
    if (!voice.isInVoice()) {
      await interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await voice.speak('Alright, I\'m heading out! Catch you later!');
    voice.leaveVoice();
    await interaction.editReply('👋 Left the voice channel.');
  },
};
