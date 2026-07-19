#!/usr/bin/env node

import { redact } from "./sanitize.js";

const scriptUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/vendor-modules.1233105e876f3039.js";

const terms = [
  "webGetFiles",
  "webGetDownloadCenterHub",
  "getUsersTeams",
  "getMyDownloadedFiles",
  "getCurrentUsersAccountId",
  "persona_id",
  "personaId",
  "cachedDownloadCenterHubData",
  "contentShare",
  "downloadCenter",
  "rpcRequest",
  "baseUrl",
  "blazeHeaders",
  "sessionKey",
  "x-blaze-id",
  "X-BLAZE-ID",
  "authentication/login"
  ,"refreshSessionData"
  ,"accessToken"
  ,"productName"
  ,"getBlazeProduct"
  ,"AuthenticatePostUrl"
];

async function main() {
  const text = await fetchText(scriptUrl);
  const decoder = buildDecoder(text);

  for (const term of terms) {
    console.log(`\n\n######## ${term} ########`);
    printContexts(text, term, decoder);
  }
}

function printContexts(text, term, decoder) {
  let index = text.indexOf(term);
  let count = 0;

  while (index !== -1 && count < 10) {
    const start = Math.max(0, index - 2500);
    const end = Math.min(text.length, index + term.length + 2500);
    const context = decodeCalls(text.slice(start, end), decoder)
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/\s+/g, " ");

    console.log(`\n--- ${term} #${count + 1} ---`);
    console.log(redact(context));
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
}

function decodeCalls(text, decoder) {
  return text.replace(/_0x[0-9a-f]+\((0x[0-9a-f]+)\)/gi, (match, hex) => {
    try {
      return JSON.stringify(decoder(Number.parseInt(hex, 16)));
    } catch {
      return match;
    }
  });
}

function buildDecoder(text) {
  const values = Function(`return ${extractStringArray(text)};`)();
  rotate(values);
  return (hex) => values[hex - 0x114];
}

function extractStringArray(text) {
  const marker = "const _0x223d5f=[";
  const start = text.indexOf(marker);
  if (start === -1) throw new Error("Could not find vendor string table.");

  let index = start + "const _0x223d5f=".length;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start + "const _0x223d5f=".length, index + 1);
      }
    }
  }
  throw new Error("Could not parse vendor string table.");
}

function rotate(values) {
  const dec = (hex) => values[hex - 0x114];
  while (true) {
    try {
      const check =
        -parseInt(dec(0x596)) / 0x1 +
        parseInt(dec(0xd7c)) / 0x2 * (-parseInt(dec(0x2898)) / 0x3) +
        -parseInt(dec(0x46e)) / 0x4 * (-parseInt(dec(0x1df)) / 0x5) +
        -parseInt(dec(0x2277)) / 0x6 +
        parseInt(dec(0x2565)) / 0x7 * (-parseInt(dec(0x13bf)) / 0x8) +
        parseInt(dec(0x2c0a)) / 0x9 * (-parseInt(dec(0x2550)) / 0xa) +
        parseInt(dec(0x4f8)) / 0xb * (parseInt(dec(0x1fe2)) / 0xc);
      if (check === 0x4a295) break;
      values.push(values.shift());
    } catch {
      values.push(values.shift());
    }
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/javascript,text/javascript,*/*",
      "user-agent": "cfb-dynasty-bot-discovery/0.1"
    }
  });

  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return response.text();
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
