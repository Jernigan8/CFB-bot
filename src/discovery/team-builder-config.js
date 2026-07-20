#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { redact } from "./sanitize.js";

const landingUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/landing";
const baseUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/";
const resultsDir = path.resolve(config.projectRoot, "discovery", "results");

const interestingPatterns = [
  /COLLEGEFB[-_A-Z0-9]*/gi,
  /(?:client[_-]?id|clientId)["':=\s]+[A-Za-z0-9_.-]+/gi,
  /(?:blaze|nexus|identity|auth|token|persona|pid|product|serviceYear|service[_-]?year)[A-Za-z0-9_.:/?&=%-]{0,180}/gi,
  /https?:\/\/[A-Za-z0-9_.:/?&=%-]*ea[A-Za-z0-9_.:/?&=%-]*/gi,
  /\/[A-Za-z0-9_.~/-]*(?:blaze|nexus|identity|auth|token|persona|ugc|team)[A-Za-z0-9_.~/?&=%-]*/gi
];

async function main() {
  const html = await fetchText(landingUrl);
  const assets = discoverAssets(html);
  const findings = [];

  findings.push({
    source: landingUrl,
    type: "html",
    matches: scanText(html)
  });

  for (const asset of assets) {
    const url = new URL(asset, baseUrl).toString();
    const text = await fetchText(url);
    findings.push({
      source: url,
      type: asset.endsWith(".js") ? "script" : "asset",
      bytes: text.length,
      matches: scanText(text)
    });
  }

  const compact = findings
    .map((finding) => ({
      ...finding,
      matches: unique(finding.matches).slice(0, 250)
    }))
    .filter((finding) => finding.matches.length > 0);

  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `team-builder-${stamp}.json`);
  await fs.writeFile(outPath, `${redact(compact)}\n`, "utf8");

  for (const finding of compact) {
    console.log(`\n== ${finding.source} ==`);
    for (const match of finding.matches.slice(0, 80)) {
      console.log(match);
    }
  }

  console.log(`\nSaved Team Builder config scan to ${outPath}`);
}

function discoverAssets(html) {
  const attrs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g)).map((match) => match[1]);
  return unique(attrs.filter((value) => value.endsWith(".js") || value.endsWith(".mjs") || value.includes(".js?")));
}

function scanText(text) {
  const matches = [];
  for (const pattern of interestingPatterns) {
    matches.push(...Array.from(text.matchAll(pattern)).map((match) => clean(match[0])));
  }
  return matches.filter(Boolean);
}

function clean(value) {
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .slice(0, 260);
}

function unique(values) {
  return [...new Set(values)];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/javascript,text/javascript,*/*",
      "user-agent": "cfb-dynasty-bot-discovery/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return response.text();
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
