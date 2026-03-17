function shuffle(values) {
  const cloned = [...values];

  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [cloned[index], cloned[randomIndex]] = [cloned[randomIndex], cloned[index]];
  }

  return cloned;
}

function getPlayerElo(playerId, players) {
  return players[playerId] && Number.isFinite(players[playerId].elo)
    ? players[playerId].elo
    : 1000;
}

function splitBalancedTeams(playerIds, players) {
  const sortedPlayers = shuffle(playerIds).sort(
    (leftId, rightId) => getPlayerElo(rightId, players) - getPlayerElo(leftId, players),
  );

  const radiant = [];
  const dire = [];
  let radiantTotalElo = 0;
  let direTotalElo = 0;

  for (const playerId of sortedPlayers) {
    const playerElo = getPlayerElo(playerId, players);

    if (radiant.length >= 5) {
      dire.push(playerId);
      direTotalElo += playerElo;
      continue;
    }

    if (dire.length >= 5) {
      radiant.push(playerId);
      radiantTotalElo += playerElo;
      continue;
    }

    if (radiantTotalElo <= direTotalElo) {
      radiant.push(playerId);
      radiantTotalElo += playerElo;
      continue;
    }

    dire.push(playerId);
    direTotalElo += playerElo;
  }

  return {
    radiant,
    dire,
    radiantTotalElo,
    direTotalElo,
  };
}

function createMatchId(nextMatchNumber) {
  return `M${String(nextMatchNumber).padStart(4, '0')}`;
}

module.exports = {
  splitBalancedTeams,
  createMatchId,
};
