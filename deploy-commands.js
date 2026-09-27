'use strict';

/** Register the 3 guild slash commands. */

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
for (const file of fs.readdirSync(path.join(__dirname, 'commands'))) {
  if (!file.endsWith('.js')) continue;
  const cmd = require(path.join(__dirname, 'commands', file));
  commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`[deploy] Registering ${commands.length} guild commands...`);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log(`[deploy] ✅ Done — ${commands.length} commands registered.`);
})().catch((err) => {
  console.error('[deploy] failed:', err.message);
  process.exit(1);
});
