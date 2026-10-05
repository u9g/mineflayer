// The Bedrock packet format of the health core (./health.js): decodes clientbound packets into
// core events and encodes core outputs into serverbound packets. It remembers the player's runtime
// id from start_game, since Bedrock packets name the player by it.

const RESPAWN_READY_TO_SPAWN = 1
const RESPAWN_CLIENT_READY_TO_SPAWN = 2
const ATTRIBUTES = { 'minecraft:health': 'health', 'minecraft:player.hunger': 'food', 'minecraft:player.saturation': 'foodSaturation' }

// legacyRuntimeIds: the version (1.16.201) writes runtime ids as numbers, not bigints
function createBedrockCodec ({ legacyRuntimeIds = false } = {}) {
  let runtimeId
  const playerId = () => legacyRuntimeIds ? Number(runtimeId) : runtimeId

  return {
    // In the order the plugin registered its listeners before, since handler order is observable
    packets: ['start_game', 'death_info', 'set_health', 'respawn', 'update_attributes'],

    // Returns the core event for a packet, or null if it means nothing to the core
    decode (name, data) {
      if (name === 'start_game') {
        if (runtimeId !== undefined) return null
        runtimeId = data.runtime_entity_id
        return { type: 'joined' }
      }
      if (name === 'death_info') return { type: 'deathInfo', cause: data.cause, messages: data.messages }
      if (name === 'set_health') return { type: 'healthUpdate', health: data.health }
      if (name === 'respawn') {
        if (data.state !== RESPAWN_READY_TO_SPAWN && data.state !== 'ready_to_spawn') return null
        const position = data.position ?? (data.x != null ? { x: data.x, y: data.y, z: data.z } : { x: 0, y: 0, z: 0 })
        return { type: 'respawnReady', position }
      }
      if (name === 'update_attributes') {
        // Attributes of other entities; until start_game names the player, take them all
        if (runtimeId !== undefined && String(data.runtime_entity_id) !== String(runtimeId)) return null
        const update = { type: 'healthUpdate' }
        for (const attribute of data.attributes || []) {
          const key = ATTRIBUTES[attribute.name]
          if (!key) continue
          update[key] = attribute.current
          if (key === 'health' && typeof attribute.max === 'number') update.maxHealth = attribute.max
        }
        return update
      }
      throw new Error(`health codec can't decode ${name}`)
    },

    // Returns the packets for an output, as { name, data }
    encode (output) {
      // The connection sends set_local_player_as_initialized once on joining; a respawn needs none
      if (output.type === 'clientLoaded') return []
      if (output.type === 'readyToSpawn') {
        const { position } = output
        return [{
          name: 'respawn',
          data: { position, x: position.x, y: position.y, z: position.z, state: RESPAWN_CLIENT_READY_TO_SPAWN, runtime_entity_id: playerId() }
        }]
      }
      if (output.type === 'requestRespawn') {
        const origin = { x: 0, y: 0, z: 0 }
        return [{
          name: 'player_action',
          data: { runtime_entity_id: playerId(), action: 'respawn', position: origin, result_position: origin, face: -1 }
        }]
      }
      throw new Error(`health codec can't encode ${output.type}`)
    }
  }
}

module.exports = { createBedrockCodec }
