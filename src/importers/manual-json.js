import fs from "node:fs/promises";

export async function importLeagueJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  validateLeagueShape(data);
  return data;
}

function validateLeagueShape(data) {
  if (!data.league || !Array.isArray(data.teams) || !Array.isArray(data.games)) {
    throw new Error("Import must include league, teams[], and games[].");
  }

  const teamIds = new Set(data.teams.map((team) => team.id));
  for (const game of data.games) {
    if (!teamIds.has(game.awayTeamId) || !teamIds.has(game.homeTeamId)) {
      throw new Error(`Game ${game.id} references an unknown team.`);
    }
  }
}
