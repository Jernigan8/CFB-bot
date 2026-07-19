import { currentWeekGames, sortedStandings, teamById } from "./league.js";

function record(team) {
  return `${team.wins}-${team.losses}`;
}

function gameLine(league, game) {
  const away = teamById(league, game.awayTeamId);
  const home = teamById(league, game.homeTeamId);
  const marker = game.spotlight ? "GAME OF THE WEEK: " : "";

  if (game.status === "final") {
    return `${marker}${away.name} ${game.awayScore} at ${home.name} ${game.homeScore} FINAL`;
  }

  return `${marker}${away.name} (${record(away)}) at ${home.name} (${record(home)})`;
}

export function renderSchedule(league) {
  const games = currentWeekGames(league);
  const lines = games.length > 0
    ? games.map((game) => `- ${gameLine(league, game)}`)
    : ["- No games scheduled for this week."];

  return [
    `**${league.league.name} - Week ${league.league.week} Schedule**`,
    ...lines
  ].join("\n");
}

export function renderStandings(league) {
  const lines = sortedStandings(league).map((team, index) => {
    const diff = team.pointsFor - team.pointsAgainst;
    const sign = diff >= 0 ? "+" : "";
    return `${index + 1}. ${team.name} (${record(team)}) ${sign}${diff} PD - ${team.coach}`;
  });

  return [
    `**${league.league.name} Standings**`,
    ...lines
  ].join("\n");
}

export function renderResult(league, game) {
  return [
    `**Final: Week ${game.week}**`,
    gameLine(league, game)
  ].join("\n");
}

export function renderAdvance(league) {
  return [
    `**${league.league.name} Advanced**`,
    `We are now in Week ${league.league.week}.`,
    "",
    renderSchedule(league)
  ].join("\n");
}

export function renderMatchups(league) {
  const games = currentWeekGames(league);
  if (games.length === 0) {
    return `**Week ${league.league.week} Matchups**\nNo games scheduled.`;
  }

  const previews = games.map((game) => {
    const away = teamById(league, game.awayTeamId);
    const home = teamById(league, game.homeTeamId);
    const awayDiff = away.pointsFor - away.pointsAgainst;
    const homeDiff = home.pointsFor - home.pointsAgainst;
    const headline = game.spotlight ? "Game of the Week" : "Matchup";

    return [
      `**${headline}: ${away.name} at ${home.name}**`,
      `${away.coach} brings ${away.name} in at ${record(away)} with a ${awayDiff >= 0 ? "+" : ""}${awayDiff} point differential.`,
      `${home.coach} has ${home.name} at ${record(home)} with a ${homeDiff >= 0 ? "+" : ""}${homeDiff} point differential.`
    ].join("\n");
  });

  return [`**Week ${league.league.week} Matchup Preview**`, ...previews].join("\n\n");
}
