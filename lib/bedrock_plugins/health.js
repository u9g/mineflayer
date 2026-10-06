const { createConfig, createState, step } = require('../core/healthBedrock')
const { createBedrockCodec } = require('../core/healthCodecBedrock')
const { createDriver } = require('../core/driver')

module.exports = inject

// Bedrock's health core and packets, emitting the same events as lib/plugins/health.js.
// Bedrock also ships the death cause and the formatted death messages (Java exposes neither on its
// bare 'death' event): the last one is on bot.deathCause, and 'deathInfo' fires with it.
function inject (bot, options) {
  const state = createState()
  const { dispatch, listen, stop, exposeState } = createDriver(bot, {
    step,
    config: createConfig({ respawn: options.respawn }),
    state,
    codec: createBedrockCodec({ legacyRuntimeIds: bot._client.options?.version === '1.16.201' }),
    send: (name, data) => bot._client.queue(name, data)
  })

  exposeState(['isAlive', 'health', 'food', 'foodSaturation', 'deathCause'])
  listen()

  bot.respawn = () => dispatch({ type: 'respawnCommand' })
  bot._client.on('close', stop)
}
