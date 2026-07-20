#!/usr/bin/env node

import { redact } from "./sanitize.js";

const scriptUrl = "https://www.ea.com/games/ea-sports-college-football/team-builder/vendor-modules.1233105e876f3039.js";

async function main() {
  const text = await fetchText(scriptUrl);
  const decoder = buildDecoder(text);
  const commands = [];
  const objectPattern = /\{[^{}]{0,500}componentId[^{}]{0,500}componentName[^{}]{0,500}commandName[^{}]{0,500}commandId[^{}]{0,500}\}/g;

  for (const match of text.matchAll(objectPattern)) {
    const objectText = match[0];
    const componentId = parseNumericField(objectText, "componentId");
    const commandId = parseNumericField(objectText, "commandId");
    const componentName = parseStringField(objectText, "componentName", decoder);
    const commandName = parseStringField(objectText, "commandName", decoder);

    if (componentName && commandName) {
      commands.push({ componentId, componentName, commandId, commandName });
    }
  }

  const uniqueCommands = uniqueBy(commands, (command) => `${command.componentName}/${command.commandName}`);
  for (const command of uniqueCommands.sort((a, b) => `${a.componentName}/${a.commandName}`.localeCompare(`${b.componentName}/${b.commandName}`))) {
    console.log(JSON.stringify(command));
  }
  console.log(`count ${uniqueCommands.length}`);
}

function parseNumericField(text, field) {
  const match = text.match(new RegExp(`${field}'?:([^,}]+)`));
  if (!match) return null;
  const value = match[1].trim();
  if (value.startsWith("0x")) return Number.parseInt(value, 16);
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function parseStringField(text, field, decoder) {
  const match = text.match(new RegExp(`${field}'?:([^,}]+)`));
  if (!match) return "";
  const value = match[1].trim();
  const literal = value.match(/^['"]([^'"]+)['"]$/);
  if (literal) return literal[1];
  const encoded = value.match(/\((0x[0-9a-f]+)\)/i);
  if (encoded) return decoder(Number.parseInt(encoded[1], 16));
  return value;
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

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
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
