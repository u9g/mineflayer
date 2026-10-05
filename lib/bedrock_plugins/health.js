const { createConfig, createState, step } = require('../core/health')
const { createBedrockCodec } = require('../core/healthCodecBedrock')
const { createDriver } = require('../core/driver')

module.exports = inject

// The same core as lib/plugins/health.js, with Bedrock's packets and its respawn handshake.
// Bedrock also ships the death cause and the formatted death messages (Java exposes neither on its
// bare 'death' event): the last one is on bot.deathCause, and 'deathInfo' fires with it.
function inject (bot, options) {
  const state = createState()
  const { dispatch, listen, stop, exposeState } = createDriver(bot, {
    step,
    // The connection itself emits the first spawn, on play_status
    config: createConfig({ respawn: options.respawn, spawnOnFirstHealth: false, respawnHandshake: true }),
    state,
    codec: createBedrockCodec({ legacyRuntimeIds: bot._client.options?.version === '1.16.201' }),
    send: (name, data) => bot._client.queue(name, data)
  })

  exposeState(['isAlive', 'health', 'food', 'foodSaturation', 'deathCause'])
  listen()

  bot.respawn = () => dispatch({ type: 'respawnCommand' })
  bot._client.on('close', stop)
}
