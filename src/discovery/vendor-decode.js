#!/usr/bin/env node

import { redact } from "./sanitize.js";

const scriptUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/vendor-modules.1233105e876f3039.js";

const indexes = {
  authPostPath: 0x279,
  connectPath: 0x30a,
  gatewayIdentityPath: 0x2992,
  hideCreatePrefix: 0x14be,
  releaseTypeParam: 0x270b,
  responseTypeParam: 0xed2,
  clientIdParam: 0x14d2,
  machineProfileKeyParam: 0x2629,
  authCodePathPrefix: 0xfae,
  logoutClientParam: 0x11c4,
  logoutRedirectParam: 0x1cd7,
  authLoginPath: 0x1851,
  authorizationCodeValue: 0x2072,
  formContentType: 0x686,
  blazeLoginPath: 0x25f1,
  blazeBaseMethodName: 0x27e3,
  blazeHeadersMethodName: 0x1667,
  blazeServiceSuffix: 0x419,
  blazeVoidRespValue: 0x90e,
  blazeAcceptValue: 0xbd6,
  ps5Value: 0xa23,
  xbsxValue: 0xbb1,
  jsonResponseType: 0xd6d,
  storageBlazeSessionData: 0x211b,
  sessionKey: 0x198d,
  displayName: 0x2aa7,
  personaIdKey: 0x9a6
  , contentShareComponent: 0xe7b
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
  const dec = (hex) => decode(values, hex);
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

function decode(values, hex) {
  return values[hex - 0x114];
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
