/* eslint-env mocha */
// Bedrock health without a server: the core (lib/core/healthBedrock.js), that it emits the same events as
// the Java core, the codec (lib/core/healthCodecBedrock.js) against each version's packet schema, written
// with bedrock-protocol's serializer and parsed back as the other side would, and the plugin
// (lib/bedrock_plugins/health.js) driven by mock packets.

const assert = require('assert')
const { EventEmitter } = require('events')
const { testedVersions } = require('../lib/version')
const javaCore = require('../lib/core/health')
const bedrockCore = require('../lib/core/healthBedrock')
const { createBedrockCodec } = require('../lib/core/healthCodecBedrock')
const injectHealth = require('../lib/bedrock_plugins/health')

const bedrockVersions = ['1.26.45', '1.26.51']
// CI only runs tests whose name contains a tested Java version (mocha -g "<version>v"), so these
// suites carry the newest one and run once, with the core suite.
const ciTag = `${testedVersions[testedVersions.length - 1]}v`

const attribute = (name, current, max = 20) => ({ min: 0, max, current, default_min: 0, default_max: max, default: max, name, modifiers: [] })

// A fresh core; feed(event) steps it and returns its outputs as short labels: "readyToSpawn", "emit spawn"
function newCore ({ createConfig, createState, step }, respawn = true) {
  const config = createConfig({ respawn })
  const state = createState()
  const feed = (event) => step(config, state, event).map(o => o.type === 'emit' ? `emit ${o.event}` : o.type)
  return { state, feed }
}
// Only the bot events among labels
const emitted = (labels) => labels.filter(label => label.startsWith('emit '))

// A Bedrock core whose player start_game has named
function joinedBedrockCore (respawn = true) {
  const core = newCore(bedrockCore, respawn)
  assert.deepStrictEqual(core.feed({ type: 'joined' }), [])
  return core
}
const health = (value) => ({ type: 'healthUpdate', health: value, food: 18, foodSaturation: 2.5 })
const ready = { type: 'respawnReady', position: { x: 1, y: 64, z: 2 } }
const respawnCommand = { type: 'respawnCommand' }
const fallback = { type: 'timer', name: 'respawnFallback' }

describe(`health events are the same on Java and Bedrock ${ciTag}`, () => {
  // The same life on each edition, in that edition's core events; each step lists the bot events it must emit
  const life = [
    { java: health(20), bedrock: health(20), emits: { java: ['emit spawn', 'emit health'], bedrock: ['emit health'] } },
    { java: health(15), bedrock: health(15), emits: ['emit health'] },
    { java: health(0), bedrock: health(0), emits: ['emit health', 'emit death'] },
    // Java respawns on the next health update, Bedrock on the server's spawn point
    { java: health(20), bedrock: ready, emits: ['emit health', 'emit spawn'] },
    { java: health(19), bedrock: health(19), emits: ['emit health'] }
  ]

  it('emits the same events through a life, death and respawn', () => {
    const java = newCore(javaCore, false)
    const bedrock = joinedBedrockCore(false)
    for (const { java: javaEvent, bedrock: bedrockEvent, emits } of life) {
      assert.deepStrictEqual(emitted(java.feed(javaEvent)), emits.java ?? emits)
      assert.deepStrictEqual(emitted(bedrock.feed(bedrockEvent)), emits.bedrock ?? emits)
    }
    for (const key of ['isAlive', 'health', 'food', 'foodSaturation']) assert.deepStrictEqual(bedrock.state[key], java.state[key], key)
  })

  it('builds every event from the shared list', () => {
    const events = require('../lib/core/healthEvents')
    const outputs = []
    for (const core of [newCore(javaCore), joinedBedrockCore()]) {
      for (const event of [health(20), health(0), ready, health(20), { type: 'respawned' }, { type: 'deathInfo', cause: 'x' }]) {
        outputs.push(...core.feed(event))
      }
    }
    for (const label of emitted(outputs)) assert.ok(events[label.slice('emit '.length)], label)
  })
})

describe(`health core bedrock ${ciTag}`, () => {
  it('does not spawn on the first health update; the connection does', () => {
    const { feed } = joinedBedrockCore()
    assert.deepStrictEqual(feed(health(20)), ['emit health'])
  })

  it('keeps fields a partial health update leaves out', () => {
    const { state, feed } = joinedBedrockCore()
    feed(health(20))
    assert.deepStrictEqual(feed({ type: 'healthUpdate', food: 5 }), ['emit health'])
    assert.strictEqual(state.health, 20)
    assert.strictEqual(state.food, 5)
    assert.deepStrictEqual(feed({ type: 'healthUpdate', maxHealth: 30 }), [])
    assert.strictEqual(state.maxHealth, 30)
  })

  it('says ready once per death and starts the fallback on every request', () => {
    const { feed } = joinedBedrockCore(false)
    feed(health(20))
    assert.deepStrictEqual(feed(health(0)), ['emit health', 'emit death'])
    assert.deepStrictEqual(feed(respawnCommand), ['readyToSpawn', 'setTimer'])
    assert.deepStrictEqual(feed(respawnCommand), ['setTimer'])
    assert.deepStrictEqual(feed(fallback), ['requestRespawn'])
    assert.deepStrictEqual(feed(fallback), [])
  })

  it('auto-respawns once per death, not on every dead health update', () => {
    const { feed } = joinedBedrockCore()
    feed(health(20))
    assert.deepStrictEqual(feed(health(0)), ['emit health', 'emit death', 'readyToSpawn', 'setTimer'])
    assert.deepStrictEqual(feed(health(0)), ['emit health'])
  })

  it('asks to respawn when the server is ready, and places the player at full health', () => {
    const { state, feed } = joinedBedrockCore()
    feed({ type: 'healthUpdate', health: 20, maxHealth: 30 })
    feed(health(0))
    assert.deepStrictEqual(feed(ready), ['clearTimer', 'requestRespawn', 'emit health', 'emit spawn'])
    assert.strictEqual(state.health, 30)
    assert.strictEqual(state.isAlive, true)
  })

  it('answers every ready while alive (the join handshake)', () => {
    const { feed } = joinedBedrockCore()
    assert.deepStrictEqual(feed(ready), ['readyToSpawn'])
    assert.deepStrictEqual(feed(ready), ['readyToSpawn'])
  })

  it('cannot respawn before start_game names the player', () => {
    const { feed } = newCore(bedrockCore)
    assert.deepStrictEqual(feed(health(0)), ['emit health', 'emit death'])
    assert.deepStrictEqual(feed(respawnCommand), [])
  })

  it('keeps the last death cause', () => {
    const { state, feed } = joinedBedrockCore()
    assert.deepStrictEqual(feed({ type: 'deathInfo', cause: 'death.attack.lava' }), ['emit deathInfo'])
    assert.deepStrictEqual(state.deathCause, { cause: 'death.attack.lava', messages: [] })
  })
})

for (const version of bedrockVersions) {
  describe(`health codec bedrock_${version} ${ciTag}`, () => {
    let roundTrip
    before(() => {
      const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
      const serializer = createSerializer(version)
      const deserializer = createDeserializer(version)
      roundTrip = (name, params) => deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
    })

    // A codec that has seen start_game for runtime id 10
    function joinedCodec () {
      const codec = createBedrockCodec()
      assert.deepStrictEqual(codec.decode('start_game', { runtime_entity_id: 10n }), { type: 'joined' })
      return codec
    }

    it('decodes the player\'s attributes as this version sends them, and ignores other entities\'', () => {
      const codec = joinedCodec()
      const attributes = [attribute('minecraft:health', 15, 30), attribute('minecraft:player.hunger', 18), attribute('minecraft:player.saturation', 4), attribute('minecraft:movement', 0.1)]
      const own = roundTrip('update_attributes', { runtime_entity_id: 10n, attributes, tick: 0n })
      assert.deepStrictEqual(codec.decode('update_attributes', own), { type: 'healthUpdate', health: 15, maxHealth: 30, food: 18, foodSaturation: 4 })
      const other = roundTrip('update_attributes', { runtime_entity_id: 11n, attributes, tick: 0n })
      assert.strictEqual(codec.decode('update_attributes', other), null)
    })

    it('decodes set_health, death_info and a ready respawn as this version sends them', () => {
      const codec = joinedCodec()
      assert.deepStrictEqual(codec.decode('set_health', roundTrip('set_health', { health: 7 })), { type: 'healthUpdate', health: 7 })
      assert.deepStrictEqual(codec.decode('death_info', roundTrip('death_info', { cause: 'death.attack.lava', messages: ['a'] })),
        { type: 'deathInfo', cause: 'death.attack.lava', messages: ['a'] })
      const position = { x: 1, y: 64, z: 2 }
      assert.deepStrictEqual(codec.decode('respawn', roundTrip('respawn', { position, state: 1, runtime_entity_id: 0n })), { type: 'respawnReady', position })
      assert.strictEqual(codec.decode('respawn', roundTrip('respawn', { position, state: 0, runtime_entity_id: 0n })), null)
    })

    it('encodes outputs into packets whose every field this version reads comes from the codec', () => {
      const codec = joinedCodec()
      for (const output of [{ type: 'readyToSpawn', position: { x: 1, y: 64, z: 2 } }, { type: 'requestRespawn' }]) {
        for (const { name, data } of codec.encode(output)) {
          const sent = roundTrip(name, data)
          for (const key of Object.keys(sent)) assert.deepStrictEqual(sent[key], data[key], `${output.type} -> ${name}.${key}`)
        }
      }
    })
  })
}

describe(`health plugin bedrock ${ciTag}`, () => {
  // A bot with the Bedrock health plugin that has joined as runtime id 10; sent collects queued packets
  function makeBot (respawn) {
    const bot = new EventEmitter()
    const sent = []
    bot._client = new EventEmitter()
    bot._client.queue = (name, params) => sent.push({ name, params })
    injectHealth(bot, { respawn })
    bot._client.emit('start_game', { runtime_entity_id: 10n })
    const events = []
    for (const event of ['health', 'death', 'spawn', 'deathInfo']) bot.on(event, () => events.push(event))
    return { bot, sent, events }
  }
  const attributes = (runtimeId, health, food) => ({
    runtime_entity_id: runtimeId,
    attributes: [{ name: 'minecraft:health', current: health, max: 20 }, { name: 'minecraft:player.hunger', current: food }]
  })

  it('maps the player\'s attributes onto bot.health and bot.food, and ignores other entities\'', () => {
    const { bot, events } = makeBot(false)
    bot._client.emit('update_attributes', attributes(10n, 15, 18))
    bot._client.emit('update_attributes', attributes(99n, 3, 3))
    assert.strictEqual(bot.health, 15)
    assert.strictEqual(bot.food, 18)
    assert.deepStrictEqual(events, ['health'])
  })

  it('dies on zero health, then respawns through the handshake when the server is ready', () => {
    const { bot, sent, events } = makeBot(true)
    bot._client.emit('update_attributes', attributes(10n, 20, 20))
    bot._client.emit('set_health', { health: 0 })
    assert.strictEqual(bot.isAlive, false)
    assert.deepStrictEqual(sent.map(p => [p.name, p.params.state]), [['respawn', 2]])

    bot._client.emit('respawn', { state: 1, position: { x: 1, y: 64, z: 2 }, runtime_entity_id: 0n })
    assert.deepStrictEqual(sent.map(p => p.name), ['respawn', 'player_action'])
    assert.strictEqual(sent[1].params.runtime_entity_id, 10n)
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot.health, 20)
    assert.deepStrictEqual(events, ['health', 'health', 'death', 'health', 'spawn'])
    bot._client.emit('close')
  })

  it('keeps the last death cause', () => {
    const { bot, events } = makeBot(false)
    bot._client.emit('death_info', { cause: 'death.attack.lava', messages: ['a'] })
    assert.deepStrictEqual(bot.deathCause, { cause: 'death.attack.lava', messages: ['a'] })
    assert.deepStrictEqual(events, ['deathInfo'])
  })
})
