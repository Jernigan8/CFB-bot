import crypto from "node:crypto";
import http from "node:http";
import { config } from "./config.js";
import { handleInteraction } from "./interactions.js";

function verifyDiscordRequest({ body, signature, timestamp }) {
  if (!config.discordPublicKey) {
    throw new Error("DISCORD_PUBLIC_KEY is not set.");
  }
  if (!signature || !timestamp) {
    return false;
  }

  return crypto.verify(
    null,
    Buffer.from(`${timestamp}${body}`),
    discordPublicKeyObject(),
    Buffer.from(signature, "hex")
  );
}

function discordPublicKeyObject() {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const rawKey = Buffer.from(config.discordPublicKey, "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawKey]),
    format: "der",
    type: "spki"
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST" || request.url !== "/interactions") {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  const body = await readBody(request);
  const signature = request.headers["x-signature-ed25519"];
  const timestamp = request.headers["x-signature-timestamp"];

  try {
    if (!verifyDiscordRequest({ body, signature, timestamp })) {
      sendJson(response, 401, { error: "bad signature" });
      return;
    }

    const payload = JSON.parse(body);
    const result = await handleInteraction(payload);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      type: 4,
      data: {
        content: error.message,
        flags: 64
      }
    });
  }
});

server.listen(config.port, () => {
  console.log(`CFB Dynasty Bot interaction server listening on http://localhost:${config.port}`);
});
