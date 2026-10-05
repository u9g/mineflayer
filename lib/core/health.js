// Health and respawn as a sans-io state machine: step(config, state, event) -> outputs.
// No sockets, timers, event emitters or packet formats here: a codec (./healthCodec.js for Java,
// ./healthCodecBedrock.js for Bedrock) turns packets into events and outputs into packets, and the
// plugins in lib/plugins and lib/bedrock_plugins connect both to the bot.
//
// Events:  { type: 'healthUpdate', health?, food?, foodSaturation?, maxHealth? }
//                                        fields left out keep their value (Bedrock sends them apart)
//          { type: 'respawned' }        the server sent the bot to a new life or dimension (Java)
//          { type: 'joined' }           the server named the bot's player (Bedrock start_game)
//          { type: 'respawnReady', position }
//                                        the server found a spawn point (Bedrock)
//          { type: 'deathInfo', cause, messages }
//          { type: 'respawnCommand' }   bot.respawn() was called
//          { type: 'timer', name }      a timer set by a setTimer output ran out
// Outputs: { type: 'clientLoaded' }     the client is ready for the server's world
//          { type: 'readyToSpawn', position }
//                                        the client is ready to be placed (Bedrock handshake)
//          { type: 'requestRespawn' }
//          { type: 'setTimer', name, ms } / { type: 'clearTimer', name }
//          { type: 'emit', event, args } a bot event

// How long a Bedrock respawn waits for the server's spawn point before asking anyway
const RESPAWN_FALLBACK_MS = 5000

// spawnOnFirstHealth: the first health update spawns the bot (Java; Bedrock spawns on play_status).
// respawnHandshake: respawning is a handshake with the server (Bedrock), not a single packet (Java).
function createConfig ({ respawn, spawnOnFirstHealth = true, respawnHandshake = false }) {
  return Object.freeze({ autoRespawn: respawn, spawnOnFirstHealth, respawnHandshake })
}

function createState () {
  return {
    isAlive: true,
    health: undefined,
    food: undefined,
    foodSaturation: undefined,
    maxHealth: 20,
    deathCause: null,
    receivedHealth: false,
    // Respawn handshake: whether the player is known yet, and what this death has sent so far
    joined: false,
    sentReady: false,
    sentRespawnAction: false,
    respawnTimer: false
  }
}

function step (config, state, event) {
  const out = []
  if (event.type === 'healthUpdate') onHealthUpdate(config, state, event, out)
  else if (event.type === 'respawned') onRespawned(state, out)
  else if (event.type === 'joined') state.joined = true
  else if (event.type === 'respawnReady') onRespawnReady(config, state, event.position, out)
  else if (event.type === 'deathInfo') onDeathInfo(state, event, out)
  else if (event.type === 'respawnCommand') respawn(config, state, out)
  else if (event.type === 'timer' && event.name === 'respawnFallback') {
    state.respawnTimer = false
    sendRespawnAction(state, out)
  }
  return out
}

function onRespawned (state, out) {
  state.isAlive = false
  out.push(emit('respawn'))
}

function onHealthUpdate (config, state, update, out) {
  if (update.maxHealth > 0) state.maxHealth = update.maxHealth
  if (update.health === undefined && update.food === undefined && update.foodSaturation === undefined) return

  // The first health update spawns the bot, if it is alive
  if (!state.receivedHealth) {
    state.receivedHealth = true
    if (config.spawnOnFirstHealth && update.health > 0) spawn(out)
  }

  if (update.health !== undefined) state.health = update.health
  if (update.food !== undefined) state.food = update.food
  if (update.foodSaturation !== undefined) state.foodSaturation = update.foodSaturation
  out.push(emit('health'))
  if (state.health <= 0) {
    const died = state.isAlive
    if (died) {
      state.isAlive = false
      state.sentReady = false
      state.sentRespawnAction = false
      out.push(emit('death'))
    }
    // Java asks again on every dead health update; Bedrock starts its handshake once per death
    if (config.autoRespawn && (died || !config.respawnHandshake)) respawn(config, state, out)
  } else if (state.health > 0) {
    clearRespawnTimer(state, out)
    state.sentReady = false
    state.sentRespawnAction = false
    if (!state.isAlive) {
      state.isAlive = true
      spawn(out)
    }
  }
}

function onRespawnReady (config, state, position, out) {
  // While alive this is the join handshake: answer every one
  if (state.isAlive) {
    out.push({ type: 'readyToSpawn', position })
    return
  }
  if (!state.sentReady) {
    state.sentReady = true
    out.push({ type: 'readyToSpawn', position })
  }
  clearRespawnTimer(state, out)
  sendRespawnAction(state, out)
  // The client places its player at the spawn, alive and at full health, before the server restates its health
  onHealthUpdate(config, state, { health: state.maxHealth }, out)
}

function onDeathInfo (state, { cause, messages }, out) {
  state.deathCause = { cause, messages: messages || [] }
  out.push(emit('deathInfo', state.deathCause))
}

function spawn (out) {
  out.push({ type: 'clientLoaded' })
  out.push(emit('spawn'))
}

function respawn (config, state, out) {
  if (state.isAlive) return
  if (!config.respawnHandshake) {
    out.push({ type: 'requestRespawn' })
    return
  }
  // Say the client is ready (once per death), then ask to respawn once the server has a spawn point,
  // or when the fallback runs out anyway. Each call starts the fallback over.
  if (!state.joined) return
  if (!state.sentReady) {
    state.sentReady = true
    out.push({ type: 'readyToSpawn', position: { x: 0, y: 0, z: 0 } })
  }
  state.respawnTimer = true
  out.push({ type: 'setTimer', name: 'respawnFallback', ms: RESPAWN_FALLBACK_MS })
}

function sendRespawnAction (state, out) {
  if (state.sentRespawnAction || state.isAlive || !state.joined) return
  state.sentRespawnAction = true
  out.push({ type: 'requestRespawn' })
}

function clearRespawnTimer (state, out) {
  if (!state.respawnTimer) return
  state.respawnTimer = false
  out.push({ type: 'clearTimer', name: 'respawnFallback' })
}

function emit (event, ...args) { return { type: 'emit', event, args } }

module.exports = { createConfig, createState, step }
