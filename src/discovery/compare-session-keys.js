#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";

const raw = await fs.readFile("discovery/browser-webGetFiles.local.txt", "utf8");
const decodedCurl = raw.replace(/\^/g, "");
const url = decodedCurl.match(/curl\s+"([^"]+)"/i)?.[1] || "";
const browserKey = decodeURIComponent(url.split("/").pop() || "");

const blaze = JSON.parse(await fs.readFile(".blaze-session.json", "utf8"));
const localKey = String(blaze.userLoginInfo?.sessionKey || "");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

console.log(JSON.stringify({
  browserKeyLen: browserKey.length,
  browserKeyHash: hash(browserKey),
  localKeyLen: localKey.length,
  localKeyHash: hash(localKey),
  same: browserKey === localKey,
  browserKeyCharClasses: summarizeChars(browserKey)
}, null, 2));

function summarizeChars(value) {
  return {
    hasDollar: value.includes("$"),
    hasColon: value.includes(":"),
    hasSlash: value.includes("/"),
    hasPlus: value.includes("+"),
    hasEqual: value.includes("="),
    uniqueCount: new Set(value).size
  };
}
