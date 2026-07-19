#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const inputPath = path.resolve(config.projectRoot, "discovery", "browser-webGetFiles.local.txt");
const outputPath = path.resolve(config.projectRoot, "discovery", "browser-webGetFiles-response.local.json");

async function main() {
  const raw = await fs.readFile(inputPath, "utf8");
  const requests = parseCurls(raw);
  const optionsRequest = requests.find((request) => request.method === "OPTIONS");
  const request = requests.find((item) => item.method === "POST") || requests[0];

  if (optionsRequest) {
    console.log(`Preflight: ${redactUrl(optionsRequest.url)}`);
    const preflight = await fetch(optionsRequest.url, {
      method: "OPTIONS",
      headers: optionsRequest.headers
    });
    console.log(`Preflight HTTP ${preflight.status}`);
  }

  console.log(`Replaying: ${redactUrl(request.url)}`);
  console.log(`Body: ${JSON.stringify(request.body)}`);

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body)
  });

  const text = await response.text();
  console.log(`HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
  console.log(previewBody(text, 8000));

  if (response.ok) {
    await fs.writeFile(outputPath, `${redact(text)}\n`, "utf8");
    console.log(`Saved redacted response at ${outputPath}`);
  }
}

function parseCurls(raw) {
  return raw.split(/\s+&\s+curl\s+/i).map((part, index) => parseCurl(index === 0 ? part : `curl ${part}`));
}

function parseCurl(raw) {
  const decoded = raw.replace(/\^/g, "");
  const urlMatch = decoded.match(/curl\s+"([^"]+)"/i);
  if (!urlMatch) throw new Error("Could not parse curl URL.");

  const headers = {};
  for (const match of decoded.matchAll(/-H\s+"([^:"]+):\s*([^"]*)"/g)) {
    const key = match[1];
    const value = match[2].replace(/\\"/g, "\"");
    if (key.toLowerCase() === "connection") continue;
    headers[key] = value;
  }

  const isOptions = /(?:\s|^)-X\s+"OPTIONS"/i.test(decoded);
  const bodyMatch = decoded.match(/--data-raw\s+"([\s\S]*)"\s*$/);

  return {
    url: urlMatch[1],
    method: isOptions ? "OPTIONS" : "POST",
    headers,
    body: bodyMatch ? JSON.parse(bodyMatch[1].replace(/\\"/g, "\"")) : null
  };
}

function redactUrl(url) {
  return redact(url.replace(/(webGetFiles\/)[^/?#\s'")]+/ig, "$1[SESSION_KEY]"));
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
