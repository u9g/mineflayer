/* eslint-env mocha */
// Tests for inventory without a server: the sans-io core (lib/plugins/inventory/core.js) for each
// combination of its version flags, its codec (lib/plugins/inventory/codec.js) against each tested
// version's packet schema, and the plugin. test/internalTest.js covers the plugin against a
// protocol server.

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const mc = require('minecraft-protocol')
const { testedVersions } = require('../lib/version')
const { createConfig, createState, step } = require('../lib/plugins/inventory/core')
const { createCodec } = require('../lib/plugins/inventory/codec')
const injectInventory = require('../lib/plugins/inventory')

const newest = testedVersions[testedVersions.length - 1]

// Each output as a short label: "emit windowOpen", "windowClick"
const labels = (outputs) => outputs.map(o => o.type === 'emit' ? `emit ${o.event}` : o.type)

// A fresh core with the windows and items of the newest version; feed(event) steps it and
// returns the outputs. The version flags are set by hand, so one version covers them all.
function newCore ({ stateIdUsed = false, transactionPacketExists = false, ownEntityId = 1 } = {}) {
  const Item = require('prismarine-item')(newest)
  const windows = require('prismarine-windows')(newest)
  const config = createConfig({
    stateIdUsed,
    transactionPacketExists,
    createWindow: windows.createWindow,
    itemsEqual: (...args) => Item.equal(...args),
    ownEntityId: () => ownEntityId
  })
  const state = createState(config)
  const feed = (event) => step(config, state, event)
  return { Item, state, feed }
}

describe(`inventory core ${newest}v`, () => {
  describe('clicks confirmed by transaction packets (before 1.17)', () => {
    const flags = { transactionPacketExists: true }

    it('sends a click with a new action id and waits for its transaction', () => {
      const { state, feed } = newCore(flags)
      const request = {}
      const out = feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request })
      assert.deepStrictEqual(labels(out), ['windowClick', 'clickSent'])
      assert.strictEqual(out[0].actionId, 1)
      assert.strictEqual(out[1].request, request)
      assert.deepStrictEqual(state.pendingClicks.map(c => c.id), [1])
      feed({ type: 'click', slot: 11, mouseButton: 0, mode: 0, request: {} })
      assert.deepStrictEqual(state.pendingClicks.map(c => c.id), [1, 2])
    })

    it('applies an accepted click and answers a rejected one', () => {
      const { state, feed } = newCore(flags)
      feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request: {} })
      feed({ type: 'click', slot: 11, mouseButton: 0, mode: 0, request: {} })
      assert.deepStrictEqual(labels(feed({ type: 'transaction', windowId: 0, actionId: 1, accepted: true })),
        ['acceptClick', 'emit confirmTransaction1', 'updateHeldItem'])
      const out = feed({ type: 'transaction', windowId: 0, actionId: 2, accepted: false })
      assert.deepStrictEqual(labels(out), ['acceptTransaction', 'emit confirmTransaction2', 'updateHeldItem'])
      assert.deepStrictEqual(out[1].args, [false])
      assert.deepStrictEqual(state.pendingClicks, [])
    })

    it('takes earlier clicks the server never answered as accepted', () => {
      const { feed } = newCore(flags)
      feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request: {} })
      feed({ type: 'click', slot: 11, mouseButton: 0, mode: 0, request: {} })
      assert.deepStrictEqual(labels(feed({ type: 'transaction', windowId: 0, actionId: 2, accepted: true })),
        ['acceptClick', 'emit confirmTransaction1', 'acceptClick', 'emit confirmTransaction2', 'updateHeldItem'])
    })

    it('accepts a transaction it did not send, as the vanilla client does', () => {
      const { feed } = newCore(flags)
      const out = feed({ type: 'transaction', windowId: 3, actionId: 7, accepted: false })
      assert.deepStrictEqual(out, [{ type: 'acceptTransaction', windowId: 3, actionId: 7 }])
    })

    it('confirms a click itself when the window needs no confirmation, after the bot listens for it', () => {
      const { state, feed } = newCore(flags)
      state.inventory.requiresConfirmation = false
      assert.deepStrictEqual(labels(feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request: {} })),
        ['windowClick', 'clickSent', 'acceptClick', 'emit confirmTransaction1', 'updateHeldItem'])
    })

    it('wraps action ids at 32767 back to 1', () => {
      const { state, feed } = newCore(flags)
      state.nextActionNumber = 32767
      assert.strictEqual(feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request: {} })[0].actionId, 1)
    })
  })

  describe('clicks applied by the client (1.17+)', () => {
    it('applies a click before sending it with the slots it changed and the current stateId', () => {
      const { Item, state, feed } = newCore({ stateIdUsed: true })
      feed({ type: 'windowItems', windowId: 0, items: [], carriedItem: undefined, stateId: 4 })
      const out = feed({ type: 'click', slot: 10, mouseButton: 0, mode: 0, request: {} })
      assert.deepStrictEqual(labels(out), ['predictClick', 'clickSent'])

      // What ./index.js does with predictClick: change the window, then report the changed slots
      const { click, window } = out[0]
      window.selectedItem = new Item(1, 1)
      const [sent] = feed({ type: 'clickPredicted', click, window, changedSlots: [10] })
      assert.strictEqual(sent.type, 'windowClick')
      assert.strictEqual(sent.stateId, 4)
      assert.deepStrictEqual(sent.changedSlots, [{ location: 10, item: null }])
      assert.strictEqual(sent.cursorItem, window.selectedItem)
      assert.deepStrictEqual(state.pendingClicks, [])
    })

    it('tracks stateId only on versions that have it', () => {
      const withStateId = newCore({ stateIdUsed: true })
      withStateId.feed({ type: 'setSlot', windowId: 0, slot: 10, item: null, stateId: 9 })
      assert.strictEqual(withStateId.state.stateId, 9)
      const without = newCore()
      without.feed({ type: 'setSlot', windowId: 0, slot: 10, item: null, stateId: undefined })
      assert.strictEqual(without.state.stateId, -1)
    })
  })

  describe('windows', () => {
    const opened = { type: 'windowOpened', windowId: 2, windowType: 'minecraft:generic_9x3', title: 'Chest', slotCount: 27 }
    const items = (windowId) => ({ type: 'windowItems', windowId, items: new Array(63).fill(null), stateId: 1 })

    it('opens a window once its slots arrive', () => {
      const { state, feed } = newCore()
      assert.deepStrictEqual(feed(opened), [])
      assert.strictEqual(state.currentWindow.id, 2)
      assert.deepStrictEqual(labels(feed(items(2))),
        ['setWindowItems', 'updateHeldItem', 'extendWindow', 'emit windowOpen', 'emit setWindowItems:2'])
      assert.deepStrictEqual(labels(feed(items(2))), ['setWindowItems', 'updateHeldItem', 'emit setWindowItems:2'])
    })

    it('opens a window at once when its slots came first', () => {
      const { feed } = newCore()
      assert.deepStrictEqual(feed(items(2)), [])
      assert.deepStrictEqual(labels(feed(opened)), ['setWindowItems', 'updateHeldItem', 'extendWindow', 'emit windowOpen'])
      // The buffer is used once
      feed({ type: 'windowClosedByServer' })
      assert.deepStrictEqual(feed(opened), [])
    })

    it('drops buffered slots on respawn and login', () => {
      for (const reset of [{ type: 'respawned' }, { type: 'login' }]) {
        const { feed } = newCore()
        feed(items(2))
        feed(reset)
        assert.deepStrictEqual(feed(opened), [])
      }
    })

    it('closes a window: tells the server, copies the inventory region back and announces it', () => {
      const { Item, state, feed } = newCore()
      feed(items(2))
      feed(opened)
      const chest = state.currentWindow
      chest.slots[chest.inventoryStart] = new Item(1, 5)
      const out = feed({ type: 'closeWindow', window: chest })
      assert.deepStrictEqual(labels(out), ['closeWindow', ...new Array(36).fill('copySlot'), 'emit windowClose'])
      assert.deepStrictEqual(out[1], { type: 'copySlot', item: chest.slots[chest.inventoryStart], slot: 9, changed: true })
      assert.strictEqual(out[2].changed, false)
      assert.strictEqual(state.currentWindow, null)
      assert.strictEqual(state.lastClosedWindow, chest)
    })

    it('applies the inventory region of a trailing sync for a closed window to the inventory', () => {
      const { state, feed } = newCore()
      feed(items(2))
      feed(opened)
      feed({ type: 'closeWindow', window: state.currentWindow })
      const [inRegion] = feed({ type: 'setSlot', windowId: 2, slot: 27, item: 'wire item', stateId: 2 })
      assert.deepStrictEqual(inRegion, { type: 'setSlot', window: state.inventory, slot: 9, item: 'wire item' })
      assert.deepStrictEqual(feed({ type: 'setSlot', windowId: 2, slot: 3, item: 'wire item', stateId: 2 }), [])
    })

    it('closes the open window on login', () => {
      const { state, feed } = newCore()
      feed(opened)
      const window = state.currentWindow
      const out = feed({ type: 'login' })
      assert.deepStrictEqual(out, [{ type: 'emit', event: 'windowClose', args: [window] }])
      assert.strictEqual(state.currentWindow, null)
    })
  })

  describe('held item', () => {
    it('sends the selected slot only when it differs from the one the server holds', () => {
      const { state, feed } = newCore()
      state.quickBarSlot = 0
      assert.deepStrictEqual(feed({ type: 'ensureCarriedItemSent' }), [])
      state.quickBarSlot = 3
      assert.deepStrictEqual(feed({ type: 'ensureCarriedItemSent' }), [{ type: 'setCarriedItem', slot: 3 }])
      assert.deepStrictEqual(feed({ type: 'ensureCarriedItemSent' }), [])
      // The server holds slot 0 again after a login
      feed({ type: 'login' })
      assert.deepStrictEqual(feed({ type: 'ensureCarriedItemSent' }), [{ type: 'setCarriedItem', slot: 3 }])
    })

    it('takes a server-sent hotbar slot and ignores one outside the hotbar', () => {
      const { state, feed } = newCore()
      assert.deepStrictEqual(labels(feed({ type: 'heldItemSlot', slot: 4 })), ['setCarriedItem', 'updateHeldItem'])
      assert.strictEqual(state.quickBarSlot, 4)
      assert.deepStrictEqual(feed({ type: 'heldItemSlot', slot: 4 }), [])
      assert.deepStrictEqual(feed({ type: 'heldItemSlot', slot: 9 }), [])
      assert.strictEqual(state.quickBarSlot, 4)
    })
  })

  describe('consuming', () => {
    function holding (core, name) {
      const { Item, state } = core
      state.quickBarSlot = 0
      state.inventory.slots[36] = new Item(require('minecraft-data')(newest).itemsByName[name].id, 1)
    }

    it('refuses food when not hungry, but not a potion', () => {
      const core = newCore()
      holding(core, 'bread')
      const request = {}
      assert.deepStrictEqual(core.feed({ type: 'consume', gameMode: 'survival', food: 20, entity: {}, request }),
        [{ type: 'consumeRefused', request, message: 'Food is full' }])
      holding(core, 'potion')
      assert.deepStrictEqual(labels(core.feed({ type: 'consume', gameMode: 'survival', food: 20, entity: {}, request: {} })),
        ['eatingStarted', 'useItem'])
      assert.strictEqual(core.state.usingHeldItem, true)
    })

    it('cancels the previous meal and finishes on the eating status for the bot only', () => {
      const core = newCore({ ownEntityId: 7 })
      holding(core, 'bread')
      const eat = { type: 'consume', gameMode: 'survival', food: 10, entity: {}, request: {} }
      core.feed(eat)
      assert.deepStrictEqual(labels(core.feed(eat)), ['eatingCancelled', 'eatingStarted', 'useItem'])
      assert.deepStrictEqual(core.feed({ type: 'entityStatus', entityId: 8, status: 9 }), [])
      assert.deepStrictEqual(labels(core.feed({ type: 'entityStatus', entityId: 7, status: 9 })), ['eatingFinished'])
      assert.strictEqual(core.state.usingHeldItem, false)
    })

    it('does not use an empty hand', () => {
      const { state, feed } = newCore()
      state.quickBarSlot = 0
      assert.deepStrictEqual(feed({ type: 'activateItem', offHand: false, entity: {} }), [])
      assert.strictEqual(state.usingHeldItem, false)
    })
  })
})

for (const version of testedVersions) {
  const registry = require('prismarine-registry')(version)
  const supportFeature = registry.supportFeature
  const protocol = require('minecraft-data')(version).protocol.play
  const Item = require('prismarine-item')(registry)
  const ChatMessage = require('prismarine-chat')(registry)
  let sequence = 0
  const codec = createCodec(supportFeature, { Item, ChatMessage, nextSequence: () => ++sequence })
  const has = (direction, name) => !!protocol[direction].types[`packet_${name}`]
  const stone = () => new Item(registry.itemsByName.stone.id, 3)

  describe(`inventory codec ${version}v`, () => {
    // Write a packet with this version's schema and parse it back, as the other side would
    let clientSends, serverSends
    before(() => {
      const roundTrip = (isServer) => {
        const serializer = mc.createSerializer({ state: 'play', isServer, version })
        const deserializer = mc.createDeserializer({ state: 'play', isServer: !isServer, version })
        return (name, params) => deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
      }
      clientSends = roundTrip(false)
      serverSends = roundTrip(true)
    })

    it('decodes slot packets as this version sends them', () => {
      const stateId = supportFeature('stateIdUsed') ? 5 : undefined
      const slot = codec.decode('set_slot', serverSends('set_slot', { windowId: 0, stateId, slot: 36, item: Item.toNotch(stone()) }))
      assert.deepStrictEqual({ ...slot, item: undefined }, { type: 'setSlot', windowId: 0, slot: 36, item: undefined, stateId })
      assert.ok(Item.equal(codec.decodeItem(slot.item), stone()))

      const items = codec.decode('window_items', serverSends('window_items', {
        windowId: 0, stateId, items: [Item.toNotch(stone()), Item.toNotch(null)], carriedItem: Item.toNotch(null)
      }))
      assert.strictEqual(items.windowId, 0)
      assert.strictEqual(items.stateId, stateId)
      assert.ok(Item.equal(codec.decodeItem(items.items[0]), stone()))
      assert.strictEqual(codec.decodeItem(items.items[1]), null)

      if (has('toClient', 'set_player_inventory')) {
        const hotbar = codec.decode('set_player_inventory', serverSends('set_player_inventory', { slotId: 2, contents: Item.toNotch(stone()) }))
        assert.strictEqual(hotbar.slot, 38)
      }
    })

    it('decodes the other packets as this version sends them', () => {
      assert.deepStrictEqual(codec.decode('held_item_slot', serverSends('held_item_slot', { slot: 4 })), { type: 'heldItemSlot', slot: 4 })
      assert.deepStrictEqual(codec.decode('entity_status', serverSends('entity_status', { entityId: 7, entityStatus: 9 })),
        { type: 'entityStatus', entityId: 7, status: 9 })
      if (has('toClient', 'transaction')) {
        assert.deepStrictEqual(codec.decode('transaction', serverSends('transaction', { windowId: 1, action: 3, accepted: false })),
          { type: 'transaction', windowId: 1, actionId: 3, accepted: false })
      }
      if (has('toClient', 'open_horse_window')) {
        assert.deepStrictEqual(codec.decode('open_horse_window', serverSends('open_horse_window', { windowId: 1, nbSlots: 17, entityId: 4 })),
          { type: 'horseWindowOpened', windowId: 1, slotCount: 17 })
      }
      // 1.21.3+ sends a cooldown group instead of an item id, which the plugin doesn't read yet
      if (protocol.toClient.types.packet_set_cooldown?.[1].some(f => f.name === 'itemID')) {
        assert.deepStrictEqual(codec.decode('set_cooldown', serverSends('set_cooldown', { itemID: 5, cooldownTicks: 20 })),
          { type: 'cooldown', itemId: 5 })
      }
    })

    it('encodes outputs into packets with the fields this version has', () => {
      const entity = { id: 3, position: new Vec3(1, 2, 3), yaw: 0, pitch: 0 }
      const outputs = [
        { type: 'windowClick', windowId: 0, stateId: 5, slot: 36, mouseButton: 0, mode: 0, actionId: 1, item: stone(), changedSlots: [{ location: 36, item: null }], cursorItem: stone() },
        { type: 'closeWindow', windowId: 1 },
        { type: 'setCarriedItem', slot: 2 },
        { type: 'useItem', offHand: false, heldItem: stone(), entity },
        { type: 'releaseUseItem' },
        { type: 'useItemOn', position: new Vec3(1, 2, 3), face: 1, cursor: new Vec3(0.5, 1, 0.5), heldItem: stone() },
        { type: 'interactEntity', entity },
        { type: 'interactEntityAt', entity, position: new Vec3(1, 3, 3) }
      ]
      if (supportFeature('stateIdUsed')) outputs.push({ type: 'resyncWindow', windowId: 0, cursorItem: null })
      if (has('toServer', 'transaction')) outputs.push({ type: 'acceptTransaction', windowId: 1, actionId: 3 })

      for (const output of outputs) {
        for (const { name, data } of codec.encode(output)) {
          // Every field the version reads back is one the codec set; extra fields the version
          // doesn't have are allowed, as the plugin always sent them. A field only some values of
          // another field have (use_entity's x for mouse 2) reads back as undefined otherwise.
          const read = clientSends(name, data)
          for (const [field, value] of Object.entries(read)) {
            if (value !== undefined) assert.ok(field in data, `${output.type} -> ${name}.${field}`)
          }
        }
      }
    })

    it('sends the click format this version has', () => {
      const [{ data }] = codec.encode({ type: 'windowClick', windowId: 0, stateId: 5, slot: 36, mouseButton: 0, mode: 0, actionId: 1, item: stone(), changedSlots: [], cursorItem: null })
      const read = clientSends('window_click', data)
      if (supportFeature('stateIdUsed')) assert.strictEqual(read.stateId, 5)
      else assert.strictEqual(read.action, 1)
    })

    it('keeps the bot API working through the plugin', async () => {
      const bot = new EventEmitter()
      bot.registry = registry
      bot.version = version
      bot.supportFeature = supportFeature
      bot._nextSequence = () => 1
      bot._client = new EventEmitter()
      const written = []
      bot._client.write = (name, data) => written.push({ name, data })
      injectInventory(bot, {})

      assert.strictEqual(bot.currentWindow, null)
      assert.strictEqual(bot.inventory.id, 0)
      const windowItems = { windowId: 0, stateId: 1, items: new Array(46).fill(Item.toNotch(null)), carriedItem: Item.toNotch(null) }
      windowItems.items[36] = Item.toNotch(stone())
      bot._client.emit('window_items', windowItems)
      bot._client.emit('held_item_slot', { slot: 0 })
      assert.ok(Item.equal(bot.heldItem, stone()))

      // A click resolves once the server accepts it, or right away where the client applies it
      const clicked = bot.clickWindow(36, 0, 0)
      if (supportFeature('transactionPacketExists')) bot._client.emit('transaction', { windowId: 0, action: 1, accepted: true })
      await clicked
      assert.deepStrictEqual(written.map(p => p.name), ['window_click'])
      assert.strictEqual(bot.heldItem, null)
      assert.ok(Item.equal(bot.inventory.selectedItem, stone()))

      // The properties stay assignable, as plain properties were
      bot.quickBarSlot = 3
      assert.strictEqual(bot.quickBarSlot, 3)
    })
  })
}
