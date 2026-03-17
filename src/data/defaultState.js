function createDefaultState() {
  return {
    queue: [],
    players: {},
    matches: [],
    nextMatchNumber: 1,
  };
}

module.exports = {
  createDefaultState,
};
