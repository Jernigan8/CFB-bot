import { advanceWeek, recordGameResult } from "./league.js";
import { renderAdvance, renderMatchups, renderResult, renderSchedule, renderStandings } from "./messages.js";
import { loadLeague, saveLeague } from "./store.js";

export async function handleInteraction(interaction) {
  if (interaction.type === 1) {
    return { type: 1 };
  }

  if (interaction.type !== 2) {
    return ephemeral("Unsupported interaction type.");
  }

  const command = interaction.data.name;

  try {
    if (command === "schedule") {
      const league = await loadLeague();
      return channelMessage(renderSchedule(league));
    }

    if (command === "standings") {
      const league = await loadLeague();
      return channelMessage(renderStandings(league));
    }

    if (command === "matchups") {
      const league = await loadLeague();
      return channelMessage(renderMatchups(league));
    }

    if (command === "result") {
      const options = optionMap(interaction.data.options);
      const league = await loadLeague();
      const { game } = recordGameResult(
        league,
        options.game_id,
        options.away_score,
        options.home_score
      );
      await saveLeague(league);
      return channelMessage(renderResult(league, game));
    }

    if (command === "advance") {
      const league = await loadLeague();
      advanceWeek(league);
      await saveLeague(league);
      return channelMessage(renderAdvance(league));
    }

    return ephemeral(`Unknown command: ${command}`);
  } catch (error) {
    return ephemeral(error.message);
  }
}

function optionMap(options = []) {
  return Object.fromEntries(options.map((option) => [option.name, option.value]));
}

function channelMessage(content) {
  return {
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] }
    }
  };
}

function ephemeral(content) {
  return {
    type: 4,
    data: {
      content,
      flags: 64,
      allowed_mentions: { parse: [] }
    }
  };
}
