#!/usr/bin/env node

import { redact } from "./sanitize.js";

const scripts = [
  "https://www.ea.com/games/ea-sports-college-football/team-builder/main.b46224aef30a3e85.js",
  "https://www.ea.com/games/ea-sports-college-football/team-builder/vendor-modules.1233105e876f3039.js"
];

const terms = [
  "COLLEGEFB-UGC",
  "blaze_application_key",
  "blaze_service_year",
  "blaze_wal_url",
  "blaze_url",
  "authorization_endpoint",
  "authentication_source",
  "client_id",
  "AuthenticatePostUrl",
  "blazeCodeUrl",
  "authentication/login",
  "accounts.ea.com",
  "gateway.ea.com"
];

async function main() {
  for (const script of scripts) {
    const text = await fetchText(script);
    console.log(`\n\n######## ${script} ########`);
    for (const term of terms) {
      printContexts(text, term);
    }
  }
}

function printContexts(text, term) {
  let index = text.indexOf(term);
  let count = 0;
  while (index !== -1 && count < 8) {
    const start = Math.max(0, index - 900);
    const end = Math.min(text.length, index + term.length + 900);
    const context = text
      .slice(start, end)
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/\s+/g, " ");

    console.log(`\n--- ${term} #${count + 1} ---`);
    console.log(redact(context));
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/javascript,text/javascript,*/*",
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
