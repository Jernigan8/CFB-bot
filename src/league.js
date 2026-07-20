export function teamById(league, teamId) {
  const team = league.teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    throw new Error(`Unknown team id: ${teamId}`);
  }
  return team;
}

export function currentWeekGames(league) {
  return league.games.filter((game) => game.week === league.league.week);
}

export function sortedStandings(league) {
  return [...league.teams].sort((a, b) => {
    const winPctA = a.wins / Math.max(1, a.wins + a.losses);
    const winPctB = b.wins / Math.max(1, b.wins + b.losses);
    if (winPctB !== winPctA) return winPctB - winPctA;

    const diffA = a.pointsFor - a.pointsAgainst;
    const diffB = b.pointsFor - b.pointsAgainst;
    if (diffB !== diffA) return diffB - diffA;

    return a.name.localeCompare(b.name);
  });
}

export function recordGameResult(league, gameId, awayScore, homeScore) {
  const game = league.games.find((candidate) => candidate.id === gameId);
  if (!game) {
    throw new Error(`Unknown game id: ${gameId}`);
  }
  if (game.status === "final") {
    throw new Error(`Game ${gameId} already has a final score.`);
  }
  if (awayScore === homeScore) {
    throw new Error("College football games cannot end in a tie.");
  }

  const away = teamById(league, game.awayTeamId);
  const home = teamById(league, game.homeTeamId);

  game.awayScore = awayScore;
  game.homeScore = homeScore;
  game.status = "final";

  away.pointsFor += awayScore;
  away.pointsAgainst += homeScore;
  home.pointsFor += homeScore;
  home.pointsAgainst += awayScore;

  if (awayScore > homeScore) {
    away.wins += 1;
    home.losses += 1;
  } else {
    home.wins += 1;
    away.losses += 1;
  }

  league.audit.push({
    at: new Date().toISOString(),
    type: "result",
    message: `${away.name} ${awayScore}, ${home.name} ${homeScore}`
  });

  return { game, away, home };
}

export function advanceWeek(league) {
  const unfinished = currentWeekGames(league).filter((game) => game.status !== "final");
  if (unfinished.length > 0) {
    throw new Error(`Cannot advance: ${unfinished.length} game(s) still unfinished.`);
  }

  league.league.week += 1;
  league.audit.push({
    at: new Date().toISOString(),
    type: "advance",
    message: `Advanced to week ${league.league.week}`
  });

  return league.league.week;
}
