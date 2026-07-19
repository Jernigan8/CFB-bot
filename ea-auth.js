#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");
const blazeSessionPath = path.resolve(config.projectRoot, ".blaze-session.json");

const blaze = {
  url: "https://wal2.tools.gos.bio-iad.ea.com/wal/",
  applicationKey: "COLLEGEFB-UGC",
  productName: "cfb-2027-pc-teambuilder",
  blazeId: "cfb-2027-pc"
};

async function main() {
  const eaSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const accessToken = eaSession?.token?.access_token;
  if (!accessToken) {
    throw new Error("No EA access token found. Run ea-auth.js exchange first.");
  }

  const response = await fetch(`${blaze.url}authentication/login`, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "x-application-key": blaze.applicationKey,
      "x-blaze-id": blaze.blazeId,
      "x-blaze-void-resp": "XML",
      "user-agent": "cfb-dynasty-bot-discovery/0.1"
    },
    body: JSON.stringify({
      accessToken,
      productName: blaze.productName
    })
  });

  const text = await response.text();
  console.log(`HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
  console.log(previewBody(text, 4000));

  if (response.ok) {
    await fs.writeFile(blazeSessionPath, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, "utf8");
    console.log(`Saved Blaze session locally at ${blazeSessionPath}`);
  }
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
