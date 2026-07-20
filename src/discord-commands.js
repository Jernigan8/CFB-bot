export const discordCommands = [
  {
    name: "schedule",
    description: "Show the current dynasty week schedule."
  },
  {
    name: "standings",
    description: "Show current dynasty standings."
  },
  {
    name: "matchups",
    description: "Show current week matchup previews."
  },
  {
    name: "result",
    description: "Record a final score.",
    options: [
      {
        name: "game_id",
        description: "Game id from the schedule, for example g001.",
        type: 3,
        required: true
      },
      {
        name: "away_score",
        description: "Away team score.",
        type: 4,
        required: true
      },
      {
        name: "home_score",
        description: "Home team score.",
        type: 4,
        required: true
      }
    ]
  },
  {
    name: "advance",
    description: "Advance the dynasty week when all games are final."
  }
];
