'use strict';

/** /join — join YOUR voice channel and say hi out loud. */

const { SlashCommandBuilder } = require('discord.js');
const voice = require('../utils/voice');

const GREETING = "Yo! I'm here — what's good?";

module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and talk'),
  async execute(interaction) {
    const vc = interaction.member?.voice?.channel;
    if (!vc) {
      await interaction.reply({
        content: '👀 Join a voice channel first, then run /join!',
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    const ok = await voice.joinVoice(vc);
    if (!ok) {
      await interaction.editReply(
        '😅 Could not connect to voice — this host may block voice traffic (Discord voice needs UDP).'
      );
      return;
    }
    await interaction.editReply(`🎙️ Joined **${vc.name}** — say hi!`);
    voice.speak(GREETING).catch(() => {});
  },
};
