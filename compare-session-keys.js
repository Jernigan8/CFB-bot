#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");

async function main() {
  const eaSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const response = await fetch("https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "X-Application-Key": "COLLEGEFB-UGC",
      "X-BLAZE-ID": "cfb-2027-pc",
      "X-BLAZE-VOID-RESP": "XML",
      "user-agent": "cfb-dynasty-bot-discovery/0.1"
    },
    body: JSON.stringify({
      accessToken: eaSession.token.access_token,
      productName: "cfb-2027-pc-teambuilder"
    })
  });

  console.log(`HTTP ${response.status}`);
  console.log(`content-type: ${response.headers.get("content-type") || ""}`);
  console.log(`set-cookie: ${redact(response.headers.get("set-cookie") || "")}`);
  console.log(previewBody(await response.text(), 1200));
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
