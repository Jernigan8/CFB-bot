#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { redact } from "./sanitize.js";

const inputPath = path.resolve(config.projectRoot, "discovery", "browser-webGetFiles.local.txt");

const raw = await fs.readFile(inputPath, "utf8");
const preview = redact(raw.slice(0, 8000))
  .replace(/(webGetFiles\/)[^/?#\s'")]+/ig, "$1[SESSION_KEY]")
  .replace(/(contentshare\/webGetFiles\/)[^/?#\s'")]+/ig, "$1[SESSION_KEY]");

console.log(`length ${raw.length}`);
console.log(preview);
