import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export const config = {
  projectRoot,
  storePath: process.env.LEAGUE_STORE_PATH
    ? path.resolve(projectRoot, process.env.LEAGUE_STORE_PATH)
    : path.resolve(projectRoot, "data", "league.json"),
  samplePath: path.resolve(projectRoot, "data", "sample-league.json"),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  discordPublicKey: process.env.DISCORD_PUBLIC_KEY || "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  discordApplicationId: process.env.DISCORD_APPLICATION_ID || "",
  discordGuildId: process.env.DISCORD_GUILD_ID || "",
  port: Number.parseInt(process.env.PORT || "3000", 10)
};
