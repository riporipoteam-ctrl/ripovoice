'use strict';

/**
 * RipoVoice — minimal Discord voice bot.
 * Three commands: /join, /leave, /say. That's it.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');
const voice = require('./utils/voice');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands'))) {
  if (!file.endsWith('.js')) continue;
  const cmd = require(path.join(__dirname, 'commands', file));
  commands.set(cmd.data.name, cmd);
}

client.once(Events.ClientReady, () => {
  console.log(`[ready] Logged in as ${client.user.tag}`);
  voice.watchVoice(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error('[cmd] failed:', err.message);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('😅 Something broke — try again.');
      } else {
        await interaction.reply({ content: '😅 Something broke — try again.', ephemeral: true });
      }
    } catch { /* noop */ }
  }
});

process.on('unhandledRejection', (err) => console.error('[fatal] unhandled:', err?.message));
process.on('uncaughtException', (err) => console.error('[fatal] uncaught:', err?.message));

client.login(process.env.DISCORD_TOKEN);
