// The bot events the health cores emit, as outputs: ./health.js (Java) and ./healthBedrock.js (Bedrock)
// both build their events here, so a bot sees the same events, with the same arguments, on either edition.

const emit = (event, ...args) => ({ type: 'emit', event, args })

module.exports = {
  // bot.health, bot.food or bot.foodSaturation changed
  health: () => emit('health'),
  death: () => emit('death'),
  spawn: () => emit('spawn'),
  // Java only: the server sent the bot to a new life or dimension
  respawn: () => emit('respawn'),
  // Bedrock only: how the bot died, as bot.deathCause
  deathInfo: (deathCause) => emit('deathInfo', deathCause)
}
