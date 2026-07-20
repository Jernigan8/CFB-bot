import fs from "node:fs/promises";

export async function importTeamBuilderResponse(responsePath, primaryJsonPath = "") {
  const response = JSON.parse(await fs.readFile(responsePath, "utf8"));
  const assets = response.results || [];

  const teams = [];
  for (const asset of assets) {
    const primary = primaryJsonPath ? JSON.parse(await fs.readFile(primaryJsonPath, "utf8")) : null;
    teams.push(summarizeAsset(asset, primary));
  }

  return {
    importedAt: new Date().toISOString(),
    source: "ea-team-builder",
    totalResultCount: response.totalResultCount ?? teams.length,
    teams
  };
}

export async function syncTeamBuilderResponse(responsePath, outputPath) {
  const response = JSON.parse(await fs.readFile(responsePath, "utf8"));
  const assets = response.results || [];
  const teams = [];

  for (const asset of assets) {
    const primary = asset.primaryURL ? await fetchPrimaryJson(asset.primaryURL) : null;
    teams.push(summarizeAsset(asset, primary));
  }

  const summary = {
    importedAt: new Date().toISOString(),
    source: "ea-team-builder",
    totalResultCount: response.totalResultCount ?? teams.length,
    teams
  };

  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export function summarizeAsset(asset, primary = null) {
  const info = primary?.teamData?.teamInfos || {};
  const roster = Object.values(primary?.teamData?.roster?.playerData || {});

  return {
    assetId: asset.assetId,
    name: info.TEAM_NAME || asset.assetName,
    nickname: info.TEAM_NICKNAME || asset.assetNickname,
    abbreviation: info.TEAM_SHORTNAME || asset.assetAbbreviation,
    city: info.CITY_NAME || "",
    state: info.CITY_STATE || "",
    stadium: info.STADIUM_NAME || "",
    brand: info.BRAND_ID || "",
    offensivePlaybookId: info.OFF_PLAYBOOK_ID || "",
    defensivePlaybookId: info.DEF_PLAYBOOK_ID || "",
    owner: {
      userId: asset.userId,
      blazeId: asset.blazeId,
      name: asset.originName
    },
    downloads: asset.downloads,
    platform: asset.platform,
    urls: {
      primary: asset.primaryURL,
      thumbnail: asset.thumbnailURL,
      fieldThumbnail: asset.fieldThumbnail,
      metadata: asset.webMetaDataURL
    },
    colors: {
      primary: asset.primaryColor,
      secondary: asset.secondaryColor,
      tertiary: asset.tertiaryColor
    },
    roster: {
      count: roster.length,
      topPlayers: roster
        .map(summarizePlayer)
        .sort((a, b) => b.overall - a.overall)
        .slice(0, 10)
    },
    rawTeamInfoKeyCount: Object.keys(info).length
  };
}

function summarizePlayer(player) {
  return {
    id: player.PLYR_ID,
    firstName: player.PLYR_FIRSTNAME,
    lastName: player.PLYR_LASTNAME,
    jerseyNumber: numberOrNull(player.PLYR_JERSEYNUM),
    positionCode: numberOrNull(player.PLYR_POSITION),
    overall: numberOrNull(player.PLYR_OVERALLRATING) ?? 0,
    speed: numberOrNull(player.PLYR_SPEED),
    schoolYear: numberOrNull(player.PLYR_SCHOOLYEAR),
    starRating: numberOrNull(player.GC_PLYR_PROSPECTSTARRATING)
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchPrimaryJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "cfb-dynasty-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Team Builder primary JSON: HTTP ${response.status}`);
  }

  return response.json();
}
