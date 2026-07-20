#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");
const products = [
  "cfb-2027-ps5",
  "cfb-2027-ps5-teambuilder",
  "cfb-2027-pc",
  "cfb-2027-pc-teambuilder"
];

async function main() {
  const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const accessToken = session?.token?.access_token;
  if (!accessToken) throw new Error("Missing EA access token.");

  for (const productName of products) {
    const blazeId = productName.replace("-teambuilder", "");
    const response = await fetch("https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "x-application-key": "COLLEGEFB-UGC",
        "x-blaze-id": blazeId,
        "x-blaze-void-resp": "XML",
        "user-agent": "cfb-dynasty-bot-discovery/0.1"
      },
      body: JSON.stringify({ accessToken, productName })
    });
    const text = await response.text();

    console.log(`\n== product ${productName} / blaze ${blazeId} ==`);
    console.log(`HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
    console.log(previewBody(text, 1600));
  }
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
