import { config } from "./config.js";
import { discordCommands } from "./discord-commands.js";

async function main() {
  if (!config.discordBotToken || !config.discordApplicationId) {
    throw new Error("Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID before registering commands.");
  }

  const route = config.discordGuildId
    ? `/applications/${config.discordApplicationId}/guilds/${config.discordGuildId}/commands`
    : `/applications/${config.discordApplicationId}/commands`;

  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method: "PUT",
    headers: {
      "authorization": `Bot ${config.discordBotToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(discordCommands)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Command registration failed: ${response.status} ${body}`);
  }

  const body = await response.json();
  console.log(`Registered ${body.length} command(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
