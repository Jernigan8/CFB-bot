#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { previewBody, redact } from "./sanitize.js";

const sessionPath = path.resolve(config.projectRoot, ".ea-session.json");
const blazeSessionPath = path.resolve(config.projectRoot, ".blaze-session.json");
const contextPath = path.resolve(config.projectRoot, "discovery", "context.local.json");

const blaze = {
  url: "https://wal2.tools.gos.bio-iad.ea.com/wal/",
  applicationKey: "COLLEGEFB-UGC",
  productName: "cfb-2027-pc-teambuilder",
  loginBlazeId: "cfb-2027-pc",
  commandBlazeIds: ["cfb-2027-pc"],
  component: "contentshare"
};

const ea = {
  clientId: process.env.EA_CLIENT_ID || "CFB_27_TEAM-BUILDER_DM_JS_WEB",
  clientSecret: process.env.EA_CLIENT_SECRET || "tBUspnwgHjhb41AqyhWuBpkacrg8v56IwIMM9iDREXQpnsvplP4FWGOA7ezGBLI5s_20260612213328",
  tokenUrl: process.env.EA_TOKEN_URL || "https://accounts.ea.com/connect/token"
};

async function main() {
  let eaSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const context = await readJsonIfExists(contextPath);
  let accessToken = eaSession?.token?.access_token;
  if (!accessToken) throw new Error("No EA access token found. Run ea-auth.js exchange first.");

  let blazeSession = await loadUsableBlazeSession();
  if (!blazeSession) {
    blazeSession = await login(accessToken);
  }
  let sessionKey = blazeSession?.userLoginInfo?.sessionKey;
  if (!sessionKey) {
    console.log(JSON.stringify(redact(blazeSession), null, 2));
    throw new Error("Blaze login did not return a sessionKey.");
  }

  const accountId = Number.parseInt(context?.pidId ?? blazeSession?.userLoginInfo?.pidId ?? "0", 10);
  const readOnlyCommands = [
    { name: "webGetFiles", payload: teamBuilderFilesPayload(accountId) },
    { name: "webGetFiles", payload: downloadedFilesPayload(accountId) },
    { name: "webGetDownloadCenterHub", payload: { requestData: { authCode: {}, authData: {}, authType: 0 } } }
  ];

  for (const commandBlazeId of blaze.commandBlazeIds) {
    console.log(`\n\n### command X-BLAZE-ID ${commandBlazeId} ###`);
    for (const command of readOnlyCommands) {
      const result = await callCommand(command.name, sessionKey, command.payload, commandBlazeId);
      if (result?.error?.errorname === "ERR_AUTHENTICATION_REQUIRED") {
        console.log("Refreshing EA token and Blaze session, then retrying once...");
        eaSession = await refreshEaSession(eaSession);
        accessToken = eaSession.token.access_token;
        blazeSession = await login(accessToken);
        sessionKey = blazeSession?.userLoginInfo?.sessionKey;
        await callCommand(command.name, sessionKey, command.payload, commandBlazeId);
      }
    }
  }
}

function teamBuilderFilesPayload(accountId) {
  return {
    limit: 100,
    offset: 0,
    filterTypes: [0],
    filterAssetId: "",
    filterOwnerIds: [accountId],
    fileOwnerGamertag: "",
    filterExcludeOwnerIds: [],
    filterDownloadedById: 0,
    filterName: "",
    filterDescription: "",
    sortBy: "subAssets.epoch",
    sortOrder: 1,
    includeDrafts: true,
    includeHidden: true,
    includeCrossPlatform: true,
    searchTagList: [],
    stringSearchTagList: [],
    titleYear: "27"
  };
}

function downloadedFilesPayload(accountId) {
  return {
    limit: 100,
    offset: 0,
    filterTypes: [0],
    filterAssetId: "",
    filterOwnerIds: [],
    fileOwnerGamertag: "",
    filterExcludeOwnerIds: [],
    filterDownloadedById: accountId,
    filterName: "",
    filterDescription: "",
    sortBy: "",
    sortOrder: 1,
    includeDrafts: false,
    includeHidden: true,
    includeCrossPlatform: true,
    searchTagList: [],
    stringSearchTagList: []
  };
}

async function login(accessToken) {
  const response = await fetch(`${blaze.url}authentication/login`, {
    method: "POST",
    headers: blazeHeaders(blaze.loginBlazeId),
    body: JSON.stringify({
      accessToken,
      productName: blaze.productName
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Blaze login failed HTTP ${response.status}\n${previewBody(text)}`);
  }

  const session = JSON.parse(text);
  if (session?.userLoginInfo?.sessionKey) {
    await fs.writeFile(blazeSessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }
  return session;
}

async function callCommand(commandName, sessionKey, payload, commandBlazeId) {
  const url = `${blaze.url}${blaze.component}/${commandName}/${encodeURIComponent(sessionKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...blazeHeaders(commandBlazeId, { browserContext: true }),
      "cookie": `SESSION_KEY=${encodeURIComponent(sessionKey)}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  console.log(`\n== ${commandName} ==`);
  console.log(`HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
  console.log(previewBody(text, 5000));

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function blazeHeaders(blazeId, options = {}) {
  const headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "X-Application-Key": blaze.applicationKey,
    "X-BLAZE-ID": blazeId,
    "X-BLAZE-VOID-RESP": "XML",
    "user-agent": "cfb-dynasty-bot-discovery/0.1"
  };

  if (options.browserContext) {
    headers.origin = "https://www.ea.com";
    headers.referer = "https://www.ea.com/games/ea-sports-college-football/team-builder/landing";
  }

  return headers;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function loadUsableBlazeSession() {
  const session = await readJsonIfExists(blazeSessionPath);
  const sessionKey = session?.userLoginInfo?.sessionKey;
  if (!sessionKey || sessionKey === "[REDACTED]") return null;
  return session;
}

async function refreshEaSession(session) {
  const refreshToken = session?.token?.refresh_token;
  if (!refreshToken) throw new Error("No refresh_token found in .ea-session.json.");

  const response = await fetch(ea.tokenUrl, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "cfb-dynasty-bot-discovery/0.1"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ea.clientId,
      client_secret: ea.clientSecret
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`EA token refresh failed HTTP ${response.status}\n${previewBody(text, 1000)}`);
  }

  const token = JSON.parse(text);
  const nextSession = {
    ...session,
    refreshedAt: new Date().toISOString(),
    token: {
      ...session.token,
      ...token
    }
  };

  await fs.writeFile(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`, "utf8");
  return nextSession;
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
