import { config } from "./config.js";

export async function postToDiscord(content, webhookUrl = config.discordWebhookUrl) {
  if (!webhookUrl) {
    return { skipped: true, reason: "DISCORD_WEBHOOK_URL is not set." };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${body}`);
  }

  return { skipped: false };
}
