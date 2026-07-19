#!/usr/bin/env node

import path from "node:path";
import { postToDiscord } from "./discord.js";
import { advanceWeek, recordGameResult } from "./league.js";
import { renderAdvance, renderMatchups, renderResult, renderSchedule, renderStandings } from "./messages.js";
import { importLeagueJson } from "./importers/manual-json.js";
import { importTeamBuilderResponse, syncTeamBuilderResponse } from "./importers/team-builder.js";
import { probeEaCloud } from "./importers/ea-cloud-placeholder.js";
import { loadLeague, saveLeague, seedLeague } from "./store.js";

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "seed":
      await seed(args);
      break;
    case "import":
      await importJson(args);
      break;
    case "import-team-builder":
      await importTeamBuilder(args);
      break;
    case "sync-team-builder":
      await syncTeamBuilder(args);
      break;
    case "schedule":
      await printAndMaybePost(renderSchedule, args);
      break;
    case "standings":
      await printAndMaybePost(renderStandings, args);
      break;
    case "matchups":
      await printAndMaybePost(renderMatchups, args);
      break;
    case "result":
      await result(args);
      break;
    case "advance":
      await advance(args);
      break;
    case "probe-ea":
      await probe();
      break;
    case "help":
    case undefined:
      help();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function seed(args) {
  const force = args.includes("--force");
  const storePath = await seedLeague({ force });
  console.log(`Seeded sample league at ${storePath}`);
}

async function importJson(args) {
  const file = args[0];
  if (!file) {
    throw new Error("Usage: node src/cli.js import <league.json>");
  }

  const league = await importLeagueJson(path.resolve(file));
  await saveLeague(league);
  console.log(`Imported ${league.league.name}`);
}

async function importTeamBuilder(args) {
  const [responseFile, primaryFile] = args;
  if (!responseFile) {
    throw new Error("Usage: node src/cli.js import-team-builder <browser-webGetFiles-response.json> [primary-team-json]");
  }

  const imported = await importTeamBuilderResponse(path.resolve(responseFile), primaryFile ? path.resolve(primaryFile) : "");
  console.log(JSON.stringify(imported, null, 2));
}

async function syncTeamBuilder(args) {
  const [responseFile, outputFile = "discovery/team-builder-summary.local.json"] = args;
  if (!responseFile) {
    throw new Error("Usage: node src/cli.js sync-team-builder <browser-webGetFiles-response.json> [output.json]");
  }

  const summary = await syncTeamBuilderResponse(path.resolve(responseFile), path.resolve(outputFile));
  console.log(`Synced ${summary.teams.length} Team Builder team(s) to ${outputFile}`);
  for (const team of summary.teams) {
    console.log(`- ${team.name} ${team.nickname} (${team.abbreviation}) / ${team.roster.count} players / asset ${team.assetId}`);
  }
}

async function printAndMaybePost(renderer, args) {
  const league = await loadLeague();
  const message = renderer(league);
  console.log(message);
  await maybePost(message, args);
}

async function result(args) {
  const [gameId, awayScoreRaw, homeScoreRaw] = args;
  if (!gameId || awayScoreRaw === undefined || homeScoreRaw === undefined) {
    throw new Error("Usage: node src/cli.js result <gameId> <awayScore> <homeScore> [--post]");
  }

  const awayScore = Number.parseInt(awayScoreRaw, 10);
  const homeScore = Number.parseInt(homeScoreRaw, 10);
  if (!Number.isInteger(awayScore) || !Number.isInteger(homeScore)) {
    throw new Error("Scores must be integers.");
  }

  const league = await loadLeague();
  const { game } = recordGameResult(league, gameId, awayScore, homeScore);
  await saveLeague(league);

  const message = renderResult(league, game);
  console.log(message);
  await maybePost(message, args);
}

async function advance(args) {
  const league = await loadLeague();
  advanceWeek(league);
  await saveLeague(league);

  const message = renderAdvance(league);
  console.log(message);
  await maybePost(message, args);
}

async function probe() {
  const result = await probeEaCloud();
  console.log(JSON.stringify(result, null, 2));
}

async function maybePost(message, args) {
  if (!args.includes("--post")) return;

  const result = await postToDiscord(message);
  if (result.skipped) {
    console.log(`Discord post skipped: ${result.reason}`);
  } else {
    console.log("Posted to Discord.");
  }
}

function help() {
  console.log(`CFB Dynasty Bot

Commands:
  node src/cli.js seed [--force]
  node src/cli.js import <league.json>
  node src/cli.js import-team-builder <browser-webGetFiles-response.json> [primary-team-json]
  node src/cli.js sync-team-builder <browser-webGetFiles-response.json> [output.json]
  node src/cli.js schedule [--post]
  node src/cli.js standings [--post]
  node src/cli.js matchups [--post]
  node src/cli.js result <gameId> <awayScore> <homeScore> [--post]
  node src/cli.js advance [--post]
  node src/cli.js probe-ea

Set DISCORD_WEBHOOK_URL to post announcements to a Discord channel.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
