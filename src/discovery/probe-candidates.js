#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");
const candidatePath = path.resolve(config.projectRoot, "discovery", "candidate-endpoints.json");
const localContextPath = path.resolve(config.projectRoot, "discovery", "context.local.json");
const resultsDir = path.resolve(config.projectRoot, "discovery", "results");

async function main() {
  const session = await loadJson(sessionPath);
  const context = await loadContext();
  const candidates = await loadCandidates();
  const results = [];

  for (const candidate of candidates) {
    const result = await probeCandidate(candidate, session, context);
    results.push(result);
    printResult(result);
  }

  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `${stamp}.json`);
  await fs.writeFile(outPath, `${redact(results)}\n`, "utf8");
  console.log(`\nSaved redacted probe results to ${outPath}`);
}

async function probeCandidate(candidate, session, context) {
  const method = candidate.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    return {
      name: candidate.name,
      url: candidate.url,
      skipped: true,
      reason: "Only GET and HEAD probes are allowed."
    };
  }

  const url = fillTemplate(candidate.url, context);
  if (url.missing) {
    return {
      name: candidate.name,
      url: candidate.url,
      skipped: true,
      reason: `Missing discovery context value: ${url.missing}`
    };
  }

  const parsed = new URL(url.value);
  if (!parsed.hostname.endsWith(".ea.com")) {
    return {
      name: candidate.name,
      url: url.value,
      skipped: true,
      reason: "Refusing to probe non-EA host."
    };
  }

  try {
    const response = await fetch(url.value, {
      method,
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${session.token.access_token}`,
        "user-agent": "cfb-dynasty-bot-discovery/0.1"
      }
    });

    const text = method === "HEAD" ? "" : await response.text();
    return {
      name: candidate.name,
      method,
      url: url.value,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyPreview: previewBody(text)
    };
  } catch (error) {
    return {
      name: candidate.name,
      method,
      url: url.value,
      error: error.message
    };
  }
}

function printResult(result) {
  console.log(`\n== ${result.name} ==`);
  console.log(`${result.method || "GET"} ${result.url}`);
  if (result.skipped) {
    console.log(`SKIPPED: ${result.reason}`);
    return;
  }
  if (result.error) {
    console.log(`ERROR: ${redact(result.error)}`);
    return;
  }
  console.log(`HTTP ${result.status} ${result.contentType || ""}`);
  if (result.bodyPreview) {
    console.log(result.bodyPreview);
  }
}

function fillTemplate(template, context) {
  let missing = "";
  const value = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    if (context[key] === undefined || context[key] === null || context[key] === "") {
      missing = key;
      return "";
    }
    return encodeURIComponent(context[key]);
  });

  return missing ? { missing } : { value };
}

async function loadCandidates() {
  const raw = await fs.readFile(candidatePath, "utf8");
  const candidates = JSON.parse(raw);
  const extraUrlIndex = process.argv.indexOf("--url");

  if (extraUrlIndex !== -1) {
    const url = process.argv[extraUrlIndex + 1];
    if (!url) throw new Error("--url requires a value.");
    candidates.push({ name: "ad hoc candidate", method: "GET", url });
  }

  return candidates;
}

async function loadContext() {
  try {
    return await loadJson(localContextPath);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
