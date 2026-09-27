# RipoVoice 🎙️

Minimal Discord voice bot. Three commands — that's it:

- `/join` — joins YOUR voice channel and says hi out loud
- `/say <text>` — says something out loud in the voice channel
- `/leave` — leaves the voice channel (also leaves on its own after 60s alone)

Free voice: keyless Microsoft Edge neural TTS, Opus-encoded in pure JS.
No ffmpeg, no native modules, no API keys, no payment.

## Run it (your PC)

Needs Node.js 18+ and a network that allows Discord voice (UDP) —
a normal home PC works fine. It does NOT work on hosts that block
UDP (e.g. Hugging Face Spaces free tier).

```sh
npm install
cp .env.example .env
# edit .env: DISCORD_TOKEN, CLIENT_ID, GUILD_ID
node deploy-commands.js   # register the 3 commands (once)
node index.js             # start the bot
```

Invite the bot to your server with the `applications.commands` scope
(bot scope too), then join a voice channel and run `/join`.
