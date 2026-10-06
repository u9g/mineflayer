// Bedrock health and respawn as a sans-io state machine: step(config, state, event) -> outputs.
// It emits the same bot events as the Java core (./health.js), from ./healthEvents.js.
// ./healthCodecBedrock.js turns packets into events and outputs into packets, and
// lib/bedrock_plugins/health.js connects both to the bot.
//
// Unlike Java, the connection emits the first spawn (on play_status), health arrives in pieces, and
// respawning is a handshake: the client says it is ready to spawn, then asks to respawn once the
// server has a spawn point, or when a fallback timer runs out.
//
// Events:  { type: 'joined' }           start_game named the bot's player
//          { type: 'healthUpdate', health?, food?, foodSaturation?, maxHealth? }
//                                        fields left out keep their value
//          { type: 'respawnReady', position }
//                                        the server found a spawn point
//          { type: 'deathInfo', cause, messages }
//          { type: 'respawnCommand' }   bot.respawn() was called
//          { type: 'timer', name }      a timer set by a setTimer output ran out
// Outputs: { type: 'readyToSpawn', position }
//          { type: 'requestRespawn' }
//          { type: 'setTimer', name, ms } / { type: 'clearTimer', name }
//          { type: 'emit', event, args } a bot event, from ./healthEvents.js

const events = require('./healthEvents')

// How long a respawn waits for the server's spawn point before asking anyway
const RESPAWN_FALLBACK_MS = 5000

function createConfig ({ respawn }) {
  return Object.freeze({ autoRespawn: respawn })
}

function createState () {
  return {
    isAlive: true,
    health: undefined,
    food: undefined,
    foodSaturation: undefined,
    maxHealth: 20,
    deathCause: null,
    // Whether the player is known yet, and what this death's handshake has sent so far
    joined: false,
    sentReady: false,
    sentRespawnAction: false,
    respawnTimer: false
  }
}

function step (config, state, event) {
  const out = []
  if (event.type === 'joined') state.joined = true
  else if (event.type === 'healthUpdate') onHealthUpdate(config, state, event, out)
  else if (event.type === 'respawnReady') onRespawnReady(config, state, event.position, out)
  else if (event.type === 'deathInfo') onDeathInfo(state, event, out)
  else if (event.type === 'respawnCommand') respawn(state, out)
  else if (event.type === 'timer' && event.name === 'respawnFallback') {
    state.respawnTimer = false
    sendRespawnAction(state, out)
  }
  return out
}

function onHealthUpdate (config, state, update, out) {
  if (update.maxHealth > 0) state.maxHealth = update.maxHealth
  if (update.health === undefined && update.food === undefined && update.foodSaturation === undefined) return

  if (update.health !== undefined) state.health = update.health
  if (update.food !== undefined) state.food = update.food
  if (update.foodSaturation !== undefined) state.foodSaturation = update.foodSaturation
  out.push(events.health())
  if (state.health <= 0) {
    // Unlike Java, the handshake starts once per death, not on every dead health update
    if (!state.isAlive) return
    state.isAlive = false
    state.sentReady = false
    state.sentRespawnAction = false
    out.push(events.death())
    if (config.autoRespawn) respawn(state, out)
  } else if (state.health > 0) {
    clearRespawnTimer(state, out)
    state.sentReady = false
    state.sentRespawnAction = false
    if (!state.isAlive) {
      state.isAlive = true
      out.push(events.spawn())
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
  out.push(events.deathInfo(state.deathCause))
}

// Says the client is ready (once per death) and starts the fallback over
function respawn (state, out) {
  if (state.isAlive || !state.joined) return
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

module.exports = { createConfig, createState, step }
