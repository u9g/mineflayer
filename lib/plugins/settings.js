const assert = require('assert')

module.exports = inject
module.exports.defaults = defaults
module.exports.clientInformation = clientInformation

const chatToBits = {
  enabled: 0,
  commandsOnly: 1,
  disabled: 2
}

const handToBits = {
  left: 0,
  right: 1
}

const viewDistanceToBits = {
  far: 12,
  normal: 10,
  short: 8,
  tiny: 6
}

// The vanilla client's defaults (Options.java): 12 chunks, every skin layer, right hand, chat
// with colours, listing allowed, filtering off, all particles.
function defaults (options) {
  return {
    chat: options.chat || 'enabled',
    colorsEnabled: options.colorsEnabled == null
      ? true
      : options.colorsEnabled,
    viewDistance: options.viewDistance || 'far',
    difficulty: options.difficulty == null
      ? 2
      : options.difficulty,
    skinParts: options.skinParts == null
      ? {
          showCape: true,
          showJacket: true,
          showLeftSleeve: true,
          showRightSleeve: true,
          showLeftPants: true,
          showRightPants: true,
          showHat: true
        }
      : options.skinParts,
    mainHand: options.mainHand || 'right',
    enableTextFiltering: options.enableTextFiltering || false,
    enableServerListing: options.enableServerListing ?? true,
    particleStatus: 'all',
    locale: options.locale || 'en_us'
  }
}

// The Client Information packet for a settings object.
function clientInformation (settings) {
  const chatBits = chatToBits[settings.chat]
  assert.ok(chatBits != null, `invalid chat setting: ${settings.chat}`)

  let viewDistanceBits = null
  if (typeof settings.viewDistance === 'string') {
    viewDistanceBits = viewDistanceToBits[settings.viewDistance]
  } else if (typeof settings.viewDistance === 'number' && settings.viewDistance > 0) { // Make sure view distance is a valid # || should be 2 or more
    viewDistanceBits = settings.viewDistance
  }
  assert.ok(viewDistanceBits != null, `invalid view distance setting: ${settings.viewDistance}`)

  const handBits = handToBits[settings.mainHand]
  assert.ok(handBits != null, `invalid main hand: ${settings.mainHand}`)

  // cape is inverted, not used at all (legacy?)
  const skinParts = settings.skinParts.showCape << 0 |
        settings.skinParts.showJacket << 1 |
        settings.skinParts.showLeftSleeve << 2 |
        settings.skinParts.showRightSleeve << 3 |
        settings.skinParts.showLeftPants << 4 |
        settings.skinParts.showRightPants << 5 |
        settings.skinParts.showHat << 6

  return {
    locale: settings.locale || 'en_us',
    viewDistance: viewDistanceBits,
    chatFlags: chatBits,
    chatColors: settings.colorsEnabled,
    skinParts,
    mainHand: handBits,
    enableTextFiltering: settings.enableTextFiltering,
    enableServerListing: settings.enableServerListing,
    particleStatus: settings.particleStatus
  }
}

function inject (bot, options) {
  function setSettings (settings) {
    extend(bot.settings, settings)
    bot._client.write('settings', clientInformation(bot.settings))
  }

  bot.settings = defaults(options)

  // The vanilla client sends Client Information after login up to 1.20.1. From 1.20.2 it goes out
  // during the configuration phase (node-minecraft-protocol sends it with the values loader.js
  // passes as clientSettings) and again only when a setting changes.
  bot._client.on('login', () => {
    if (!bot.supportFeature('hasConfigurationState')) setSettings({})
  })

  bot.setSettings = setSettings
}

const hasOwn = {}.hasOwnProperty
function extend (obj, src) {
  for (const key in src) {
    if (hasOwn.call(src, key)) obj[key] = src[key]
  }
  return obj
}
