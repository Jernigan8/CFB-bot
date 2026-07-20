#!/usr/bin/env node

import { redact } from "./sanitize.js";

const scriptUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/main.b46224aef30a3e85.js";

const indexes = {
  cfbApp: 0x6c9,
  serviceYear: 0x390,
  walUrl: 0x552,
  serviceEnvironment: 0x650,
  eadpClientId: 0x774,
  eadpClientSecret: 0x35a,
  machineProfileKey: 0x741,
  authorizationEndpoint: 0x678,
  gatewayEndpoint: 0x609,
  serverRoot: 0x418,
  externalContentRepoUrl: 0x356,
  externalContentVersion: 0x3a2,
  analyticsClientId: 0x612,
  analyticsAppName: 0x33f,
  analyticsCdnScript: 0x473,
  pinUrl: 0x647,
  telemetryVersion: 0x34b
};

async function main() {
  const text = await fetchText(scriptUrl);
  const arrayLiteral = extractStringArray(text);
  const values = Function(`return ${arrayLiteral};`)();
  rotate(values);

  const decoded = {};
  for (const [key, index] of Object.entries(indexes)) {
    decoded[key] = decode(values, index);
  }

  console.log(JSON.stringify(redactObject(decoded), null, 2));
}

function extractStringArray(text) {
  const marker = "const _0xe560a0=[";
  const start = text.indexOf(marker);
  if (start === -1) throw new Error("Could not find string table.");

  let index = start + "const _0xe560a0=".length;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
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
        return text.slice(start + "const _0xe560a0=".length, index + 1);
      }
    }
  }

  throw new Error("Could not parse string table.");
}

function rotate(values) {
  const dec = (hex) => decode(values, hex);
  while (true) {
    try {
      const check =
        -parseInt(dec(0x62d)) / 0x1 +
        parseInt(dec(0x3ab)) / 0x2 * (-parseInt(dec(0x76c)) / 0x3) +
        -parseInt(dec(0x793)) / 0x4 * (parseInt(dec(0x731)) / 0x5) +
        parseInt(dec(0x5cd)) / 0x6 * (-parseInt(dec(0x534)) / 0x7) +
        -parseInt(dec(0x3cf)) / 0x8 +
        parseInt(dec(0x349)) / 0x9 * (parseInt(dec(0x730)) / 0xa) +
        -parseInt(dec(0x6a1)) / 0xb * (-parseInt(dec(0x25e)) / 0xc);

      if (check === 0x978ee) break;
      values.push(values.shift());
    } catch {
      values.push(values.shift());
    }
  }
}

function decode(values, hex) {
  return values[hex - 0x1d5];
}

function redactObject(value) {
  return JSON.parse(redact(value));
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return response.text();
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
