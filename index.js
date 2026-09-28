'use strict';

/**
 * RipoVoice — minimal Discord voice bot.
 * Three commands: /join, /leave, /say. That's it.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, REST, Routes } = require('discord.js');
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

client.once(Events.ClientReady, async () => {
  console.log(`[ready] Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('[deploy] registration failed (commands may be stale):', err.message);
  }
  voice.watchVoice(client);
});

/**
 * Self-registers the 3 guild slash commands on every startup.
 * Idempotent — Discord just overwrites the same commands.
 * Skips cleanly when CLIENT_ID/GUILD_ID/DISCORD_TOKEN are missing,
 * so the panel smoke test (no token yet) still fails only on login.
 */
async function registerCommands() {
  const { CLIENT_ID, GUILD_ID, DISCORD_TOKEN } = process.env;
  if (!CLIENT_ID || !GUILD_ID || !DISCORD_TOKEN) {
    console.log('[deploy] Skipping command registration (missing CLIENT_ID/GUILD_ID/DISCORD_TOKEN).');
    return;
  }
  const body = [];
  for (const cmd of commands.values()) body.push(cmd.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  console.log(`[deploy] Registered ${body.length} guild commands.`);
}

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
