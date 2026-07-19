#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { redact } from "./sanitize.js";

const inputPath = path.resolve(config.projectRoot, "discovery", "browser-webGetFiles.local.txt");

async function main() {
  const raw = await fs.readFile(inputPath, "utf8");
  const request = parseRequest(raw);

  console.log("Captured request summary:");
  console.log(JSON.stringify(redactRequest(request), null, 2));

  const expectedHeaders = [
    "accept",
    "content-type",
    "x-application-key",
    "x-blaze-id",
    "x-blaze-void-resp"
  ];

  console.log("\nHeader check:");
  const actualHeaderKeys = Object.keys(request.headers).map((key) => key.toLowerCase()).sort();
  for (const key of expectedHeaders) {
    console.log(`${key}: ${actualHeaderKeys.includes(key) ? "present" : "missing"}`);
  }
  const interesting = actualHeaderKeys.filter((key) => !expectedHeaders.includes(key));
  console.log(`extra headers: ${interesting.join(", ") || "(none)"}`);
}

function parseRequest(raw) {
  const normalized = raw.replace(/`?\r?\n/g, "\n");
  return {
    url: parseUrl(normalized),
    headers: parseHeaders(normalized),
    body: parseBody(normalized)
  };
}

function parseUrl(text) {
  const urlMatch =
    text.match(/https:\/\/wal2\.tools\.gos\.bio-iad\.ea\.com\/wal\/[^\s'"`)]+/i) ||
    text.match(/https:\/\/[^'"\s`)]+webGetFiles[^'"\s`)]+/i);
  return urlMatch?.[0] || "";
}

function parseHeaders(text) {
  const headers = {};

  for (const match of text.matchAll(/['"]([^'"]+)['"]\s*[:=]\s*['"]([^'"]*)['"]/g)) {
    const key = match[1];
    const value = match[2];
    if (looksLikeHeader(key)) headers[key] = value;
  }

  for (const match of text.matchAll(/-H\s+['"]([^:'"]+):\s*([^'"]*)['"]/g)) {
    headers[match[1]] = match[2];
  }

  return headers;
}

function parseBody(text) {
  const bodyMatch =
    text.match(/--data-raw\s+(['"])([\s\S]*?)\1/) ||
    text.match(/-Body\s+(['"])([\s\S]*?)\1/) ||
    text.match(/body\s*:\s*(['"`])([\s\S]*?)\1/);

  if (!bodyMatch) return "";
  return bodyMatch[2].replace(/\\(["'`])/g, "$1");
}

function looksLikeHeader(key) {
  return /^(accept|authorization|content-type|origin|referer|sec-|user-agent|x-|cookie)/i.test(key);
}

function redactRequest(request) {
  const redacted = {
    url: redactUrl(request.url),
    headers: {},
    body: maybeJson(request.body)
  };

  for (const [key, value] of Object.entries(request.headers)) {
    redacted.headers[key] = /authorization|cookie/i.test(key) ? "[REDACTED]" : redact(value);
  }

  return redacted;
}

function redactUrl(url) {
  return redact(url.replace(/(webGetFiles\/)[^/?#]+/i, "$1[SESSION_KEY]"));
}

function maybeJson(text) {
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return redact(text);
  }
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
