#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");
const blazeSessionPath = path.resolve(config.projectRoot, ".blaze-session.json");
const localContextPath = path.resolve(config.projectRoot, "discovery", "context.local.json");
const command = process.argv[2];
const arg = process.argv[3];

const ea = {
  clientId: process.env.EA_CLIENT_ID || "CFB_27_TEAM-BUILDER_DM_JS_WEB",
  clientSecret: process.env.EA_CLIENT_SECRET || "tBUspnwgHjhb41AqyhWuBpkacrg8v56IwIMM9iDREXQpnsvplP4FWGOA7ezGBLI5s_20260612213328",
  redirectUri: process.env.EA_REDIRECT_URI || "https://www.ea.com/games/ea-sports-college-football/team-builder/",
  authSource: process.env.EA_AUTH_SOURCE || "325760",
  machineProfileKey: process.env.EA_MACHINE_PROFILE_KEY || "MCA4b35d75Vm-MCA",
  releaseType: process.env.EA_RELEASE_TYPE || "PROD",
  authUrl: "https://accounts.ea.com/connect/auth",
  tokenUrls: process.env.EA_TOKEN_URL
    ? [process.env.EA_TOKEN_URL]
    : [
        "https://accounts.ea.com/connect/token",
        "https://accounts2.ea.com/connect/token"
      ]
};

async function main() {
  if (command === "auth-url") {
    console.log(buildAuthUrl());
    return;
  }

  if (command === "exchange") {
    await exchangeCode(arg || await promptForCodeUrl());
    return;
  }

  if (command === "whoami") {
    await whoami();
    return;
  }

  if (command === "persona-exchange") {
    await personaExchange();
    return;
  }

  if (command === "metadata") {
    await metadata();
    return;
  }

  console.log(`EA auth helper

Commands:
  node src/discovery/ea-auth.js auth-url
  node src/discovery/ea-auth.js exchange "<redirect-url-or-code>"
  node src/discovery/ea-auth.js whoami
  node src/discovery/ea-auth.js persona-exchange
  node src/discovery/ea-auth.js metadata`);
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    authentication_source: ea.authSource,
    hide_create: "true",
    release_type: ea.releaseType,
    response_type: "code",
    redirect_uri: ea.redirectUri,
    client_id: ea.clientId
  });

  if (ea.machineProfileKey) {
    params.set("machineProfileKey", ea.machineProfileKey);
  }

  return `${ea.authUrl}?${params.toString()}`;
}

function buildPersonaAuthUrl(accessToken, persona) {
  const params = new URLSearchParams({
    authentication_source: ea.authSource,
    hide_create: "true",
    release_type: ea.releaseType,
    response_type: "code",
    redirect_uri: ea.redirectUri,
    client_id: ea.clientId,
    access_token: accessToken,
    persona_id: String(persona.personaId),
    persona_namespace: persona.namespaceName || "cem_ea_id"
  });

  if (ea.machineProfileKey) {
    params.set("machineProfileKey", ea.machineProfileKey);
  }

  return `${ea.authUrl}?${params.toString()}`;
}

async function exchangeCode(input) {
  if (!input) {
    throw new Error("Pass the local redirect URL or just the code as the next argument.");
  }

  const code = extractCode(input);
  const attempts = buildTokenAttempts(code);
  const failures = [];
  let token = null;

  for (const attempt of attempts) {
    const response = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body
    });

    const text = await response.text();
    if (response.ok) {
      token = JSON.parse(text);
      console.log(`Token exchange worked using: ${attempt.name}`);
      break;
    }

    failures.push({
      name: attempt.name,
      status: response.status,
      body: previewBody(text, 800)
    });
  }

  if (!token) {
    throw new Error([
      "Token exchange failed for every attempted format.",
      ...failures.map((failure) => [
        `\n[${failure.name}] HTTP ${failure.status}`,
        failure.body
      ].join("\n"))
    ].join("\n"));
  }

  const session = {
    createdAt: new Date().toISOString(),
    clientId: ea.clientId,
    redirectUri: ea.redirectUri,
    token
  };

  await fs.writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  console.log(`EA session saved locally at ${sessionPath}`);
}

async function personaExchange() {
  const session = await loadSession();
  const accessToken = session?.token?.access_token;
  if (!accessToken) throw new Error("No access_token found in .ea-session.json.");

  const persona = await loadPersona();
  const authUrl = buildPersonaAuthUrl(accessToken, persona);
  const response = await fetch(authUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 cfb-dynasty-bot-discovery/0.1"
    }
  });

  const location = response.headers.get("location");
  console.log(`Persona auth HTTP ${response.status}`);

  if (!location) {
    const text = await response.text();
    throw new Error([
      "Persona auth did not return a redirect with code=.",
      previewBody(text, 1000)
    ].join("\n"));
  }

  console.log(`Persona auth redirect: ${redact(location)}`);
  await exchangeCode(location);
}

async function loadPersona() {
  const raw = await fs.readFile(blazeSessionPath, "utf8");
  const blazeSession = JSON.parse(raw);
  const personaDetails = blazeSession?.userLoginInfo?.personaDetails;
  const personaId = personaDetails?.personaId || blazeSession?.userLoginInfo?.blazeId;
  if (!personaId) {
    throw new Error("No personaId found in .blaze-session.json. Run blaze-login.js first.");
  }

  return {
    personaId,
    namespaceName: personaDetails?.namespaceName || "cem_ea_id"
  };
}

async function promptForCodeUrl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question("Paste the full EA redirect URL with code= here, then press Enter:\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function buildTokenAttempts(code) {
  const baseParams = {
    grant_type: "authorization_code",
    code,
    client_id: ea.clientId,
    client_secret: ea.clientSecret,
    redirect_uri: ea.redirectUri
  };

  const companionParams = {
    ...baseParams,
    authentication_source: ea.authSource,
    release_type: ea.releaseType
  };

  if (ea.machineProfileKey) {
    companionParams.machineProfileKey = ea.machineProfileKey;
  }

  return ea.tokenUrls.flatMap((tokenUrl) => [
    {
      name: `${hostLabel(tokenUrl)} standard client_id body`,
      url: tokenUrl,
      headers: formHeaders(),
      body: new URLSearchParams(baseParams)
    },
    {
      name: `${hostLabel(tokenUrl)} CFB Team Builder params body`,
      url: tokenUrl,
      headers: formHeaders(),
      body: new URLSearchParams(companionParams)
    },
    {
      name: `${hostLabel(tokenUrl)} client_id query plus CFB body`,
      url: `${tokenUrl}?client_id=${encodeURIComponent(ea.clientId)}`,
      headers: formHeaders(),
      body: new URLSearchParams(companionParams)
    },
    {
      name: `${hostLabel(tokenUrl)} basic auth with CFB secret`,
      url: tokenUrl,
      headers: {
        ...formHeaders(),
        authorization: `Basic ${Buffer.from(`${ea.clientId}:${ea.clientSecret}`).toString("base64")}`
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ea.redirectUri,
        release_type: ea.releaseType,
        authentication_source: ea.authSource
      })
    }
  ]);
}

function hostLabel(url) {
  return new URL(url).hostname;
}

function formHeaders() {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "accept": "application/json",
    "user-agent": "MaddenCompanion/26 cfb-dynasty-bot-discovery/0.1"
  };
}

async function whoami() {
  const session = await loadSession();
  const response = await fetch("https://gateway.ea.com/proxy/identity/pids/me", {
    method: "GET",
    headers: authHeaders(session)
  });

  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(previewBody(text));

  if (response.ok) {
    await persistPidContext(text);
  }
}

async function metadata() {
  const urls = [
    "https://accounts.ea.com/.well-known/openid-configuration",
    "https://accounts.ea.com/connect/.well-known/openid-configuration",
    "https://accounts.ea.com/.well-known/oauth-authorization-server",
    "https://accounts.ea.com/connect/.well-known/oauth-authorization-server"
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "cfb-dynasty-bot-discovery/0.1"
        }
      });
      const text = await response.text();
      console.log(`\n== ${url} ==`);
      console.log(`HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
      console.log(previewBody(text, 1200));
    } catch (error) {
      console.log(`\n== ${url} ==`);
      console.log(`ERROR: ${error.message}`);
    }
  }
}

function extractCode(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("Redirect URL did not contain a code query parameter.");
    }
    return code;
  }

  return input;
}

async function loadSession() {
  const raw = await fs.readFile(sessionPath, "utf8");
  return JSON.parse(raw);
}

async function persistPidContext(text) {
  try {
    const body = JSON.parse(text);
    const pidId = body.pidId || body.pid?.pidId || body.pid?.id || body.id;
    if (!pidId) return;

    await fs.mkdir(path.dirname(localContextPath), { recursive: true });
    await fs.writeFile(localContextPath, `${JSON.stringify({ pidId }, null, 2)}\n`, "utf8");
    console.log(`Saved pidId to ${localContextPath}`);
  } catch {
    // If EA changes shape or returns non-JSON, the raw response above is still useful.
  }
}

function authHeaders(session) {
  const accessToken = session?.token?.access_token;
  if (!accessToken) {
    throw new Error("No access_token found in .ea-session.json.");
  }

  return {
    "accept": "application/json",
    "authorization": `Bearer ${accessToken}`,
    "user-agent": "cfb-dynasty-bot-discovery/0.1"
  };
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
