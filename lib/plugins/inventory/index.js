const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, sleep, createDoneTask, createTask, withTimeout } = require('../../promise_utils')
const { createConfig, createState, step, heldItem } = require('./core')
const { createCodec, vectorToDirection } = require('./codec')
const { createDriver } = require('../../sansio/driver')

module.exports = inject

// ms to wait before clicking on a tool so the server can send the new
// damage information
const DIG_CLICK_TIMEOUT = 500
// The number of milliseconds to wait for the server to respond with consume completion.
// This number is larger than the eat time of 1.61 seconds to account for latency and low tps.
// The eat time comes from https://minecraft.wiki/w/Food#Usage
const CONSUME_TIMEOUT = 2500
// milliseconds to wait for the server to respond to a window click transaction
const WINDOW_TIMEOUT = 5000

// The protocol logic is in ./core.js and the packet formats in ./codec.js. This file connects
// them to the bot, owns the windows' changes (the core's effects) and the waiting: the async
// API below is built from the core's commands.
function inject (bot, { hideErrors }) {
  const Item = require('prismarine-item')(bot.registry)
  const windows = require('prismarine-windows')(bot.version)
  const ChatMessage = require('prismarine-chat')(bot.registry)

  const config = createConfig({
    stateIdUsed: !!bot.supportFeature('stateIdUsed'),
    transactionPacketExists: !!bot.supportFeature('transactionPacketExists'),
    createWindow: (...args) => windows.createWindow(...args),
    itemsEqual: (...args) => Item.equal(...args),
    ownEntityId: () => bot.entity.id
  })
  const state = createState(config)
  const codec = createCodec(bot.supportFeature, { Item, ChatMessage, nextSequence: () => bot._nextSequence() })

  let eatingTask = createDoneTask()

  const { dispatch, listen, exposeState } = createDriver(bot, {
    step,
    config,
    state,
    codec,
    effects: {
      setSlot: ({ window, slot, item }) => bot._setSlot(slot, codec.decodeItem(item), window),
      setWindowItems: ({ window, items, carriedItem }) => {
        for (let i = 0; i < items.length; ++i) {
          window.updateSlot(i, codec.decodeItem(items[i]))
        }
        if (carriedItem !== undefined) window.selectedItem = codec.decodeItem(carriedItem)
      },
      copySlot: ({ item, slot, changed }) => {
        if (item) item.slot = slot
        if (changed) bot.inventory.updateSlot(slot, item)
      },
      predictClick: ({ click, window }) => {
        dispatch({ type: 'clickPredicted', click, window, changedSlots: predictClick(window, click) })
      },
      acceptClick: ({ window, click }) => window.acceptClick(click),
      clickSent: ({ request, click, window }) => {
        request.window = window
        if (config.transactionPacketExists) request.response = once(bot, `confirmTransaction${click.id}`)
      },
      extendWindow: ({ window }) => extendWindow(window),
      updateHeldItem: () => updateHeldItem(),
      eatingStarted: () => { eatingTask = createTask() },
      eatingFinished: () => eatingTask.finish(),
      eatingCancelled: ({ message }) => eatingTask.cancel(new Error(message)),
      consumeRefused: ({ request, message }) => { request.error = new Error(message) }
    }
  })

  exposeState(['quickBarSlot', 'inventory', 'currentWindow', 'usingHeldItem'])

  Object.defineProperty(bot, 'heldItem', {
    get: () => heldItem(state)
  })

  bot.on('spawn', () => {
    Object.defineProperty(bot.entity, 'equipment', {
      get: bot.supportFeature('doesntHaveOffHandSlot')
        ? function () {
          return [bot.heldItem, bot.inventory.slots[8], bot.inventory.slots[7],
            bot.inventory.slots[6], bot.inventory.slots[5]]
        }
        : function () {
          return [bot.heldItem, bot.inventory.slots[45], bot.inventory.slots[8],
            bot.inventory.slots[7], bot.inventory.slots[6], bot.inventory.slots[5]]
        }
    })
  })

  bot.on('heldItemChanged', (item) => dispatch({ type: 'heldItemChanged', item }))
  listen()
  state.inventory.on('updateSlot', (index) => dispatch({ type: 'inventorySlotUpdated', index }))

  async function consume () {
    const request = {}
    dispatch({ type: 'consume', gameMode: bot.game.gameMode, food: bot.food, entity: bot.entity, request })
    if (request.error) throw request.error
    await withTimeout(eatingTask.promise, CONSUME_TIMEOUT)
  }

  function activateItem (offHand = false) {
    dispatch({ type: 'activateItem', offHand, entity: bot.entity })
  }

  function deactivateItem () {
    dispatch({ type: 'deactivateItem' })
  }

  async function putSelectedItemRange (start, end, window, slot) {
    // put the selected item back indow the slot range in window

    // try to put it in an item that already exists and just increase
    // the count.

    while (window.selectedItem) {
      const item = window.findItemRange(start, end, window.selectedItem.type, window.selectedItem.metadata, true, window.selectedItem.nbt)

      if (item && item.stackSize !== item.count) { // something to join with
        await clickWindow(item.slot, 0, 0)
      } else { // nothing to join with
        const emptySlot = window.firstEmptySlotRange(start, end)
        if (emptySlot === null) { // no room left
          if (slot === null) { // no room => drop it
            await tossLeftover()
          } else { // if there is still some leftover and slot is not null, click slot
            await clickWindow(slot, 0, 0)
            await tossLeftover()
          }
        } else {
          await clickWindow(emptySlot, 0, 0)
        }
      }
    }

    async function tossLeftover () {
      if (window.selectedItem) {
        await clickWindow(-999, 0, 0)
      }
    }
  }

  async function activateBlock (block, direction, cursorPos) {
    direction = direction ?? new Vec3(0, 1, 0)
    const face = vectorToDirection(direction) // The packet needs a number as the direction
    // The cursor must lie on the clicked face
    cursorPos = cursorPos ?? new Vec3(0.5 + direction.x * 0.5, 0.5 + direction.y * 0.5, 0.5 + direction.z * 0.5)
    // TODO: tell the server that we are not sneaking while doing this
    // The point the packet reports is the one the vanilla client's crosshair ray hit, so the head
    // faces it; looking at the block's middle instead claims a hit the rotation cannot produce.
    await bot.lookAt(block.position.plus(cursorPos), false)
    dispatch({ type: 'useItemOn', position: block.position, face, cursor: cursorPos })

    // swing arm animation
    bot.swingArm()
  }

  async function activateEntity (entity) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(entity.position.offset(0, 1, 0), false)
    dispatch({ type: 'interactEntity', entity })
  }

  async function activateEntityAt (entity, position) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(position, false)
    dispatch({ type: 'interactEntityAt', entity, position })
  }

  async function transfer (options) {
    const window = options.window || bot.currentWindow || bot.inventory
    const itemType = options.itemType
    const metadata = options.metadata
    const nbt = options.nbt
    let count = (options.count === undefined || options.count === null) ? 1 : options.count
    let firstSourceSlot = null

    // ranges
    const sourceStart = options.sourceStart
    const destStart = options.destStart
    assert.notStrictEqual(sourceStart, null)
    assert.notStrictEqual(destStart, null)
    const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd
    const destEnd = options.destEnd === null ? destStart + 1 : options.destEnd

    await transferOne()

    async function transferOne () {
      if (count === 0) {
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
        return
      }
      if (!window.selectedItem || window.selectedItem.type !== itemType ||
        (metadata != null && window.selectedItem.metadata !== metadata) ||
        (nbt != null && window.selectedItem.nbt !== nbt)) {
        // we are not holding the item we need. click it.
        const sourceItem = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt)
        const mcDataEntry = bot.registry.itemsArray.find(x => x.id === itemType)
        assert(mcDataEntry, 'Invalid itemType')
        if (!sourceItem) throw new Error(`Can't find ${mcDataEntry.name} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`)
        if (firstSourceSlot === null) firstSourceSlot = sourceItem.slot
        // number of item that can be moved from that slot
        await clickWindow(sourceItem.slot, 0, 0)
      }
      await clickDest()

      async function clickDest () {
        assert.notStrictEqual(window.selectedItem.type, null)
        assert.notStrictEqual(window.selectedItem.metadata, null)
        let destItem
        let destSlot
        // special case for tossing
        if (destStart === -999) {
          destSlot = -999
        } else {
          // find a non full item that we can drop into
          destItem = window.findItemRange(destStart, destEnd,
            window.selectedItem.type, window.selectedItem.metadata, true, nbt)
          // if that didn't work find an empty slot to drop into
          destSlot = destItem
            ? destItem.slot
            : window.firstEmptySlotRange(destStart, destEnd)
          // if that didn't work, give up
          if (destSlot === null) {
            throw new Error('destination full')
          }
        }
        // move the maximum number of item that can be moved
        const destSlotCount = destItem && destItem.count ? destItem.count : 0
        const movedItems = Math.min(window.selectedItem.stackSize - destSlotCount, window.selectedItem.count)
        const target = destSlotCount + count
        const half = Math.floor(Math.min(destSlotCount + window.selectedItem.count, window.selectedItem.stackSize) / 2)
        // if the number of item the left click moves is less than the number of item we want to move
        // several at the same time (left click)
        if (movedItems <= count) {
          await clickWindow(destSlot, 0, 0)
          // update the number of item we want to move (count)
          count -= movedItems
          await transferOne()
        } else if (destSlot !== -999 && half <= target && 3 + target - half < count) {
          // A right click on a stack with an empty cursor takes the larger half.
          await clickWindow(destSlot, 0, 0)
          if (window.selectedItem) await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
          await clickWindow(destSlot, 1, 0)
          for (let missing = target - half; missing > 0; missing--) {
            await clickWindow(destSlot, 1, 0)
          }
          count = 0
          await transferOne()
        } else {
          // one by one (right click)
          await clickWindow(destSlot, 1, 0)
          count -= 1
          await transferOne()
        }
      }
    }
  }

  function extendWindow (window) {
    window.close = () => {
      const closed = closeWindow(window)
      window.emit('close')
      return closed
    }

    window.withdraw = async (itemType, metadata, count, nbt) => {
      if (bot.inventory.emptySlotCount() === 0) {
        throw new Error('Unable to withdraw, Bot inventory is full.')
      }
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: 0,
        sourceEnd: window.inventoryStart,
        destStart: window.inventoryStart,
        destEnd: window.inventoryEnd
      }
      await transfer(options)
    }
    window.deposit = async (itemType, metadata, count, nbt) => {
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: window.inventoryStart,
        sourceEnd: window.inventoryEnd,
        destStart: 0,
        destEnd: window.inventoryStart
      }
      await transfer(options)
    }
  }

  async function openBlock (block, direction, cursorPos) {
    bot.activateBlock(block, direction, cursorPos)
    const [window] = await once(bot, 'windowOpen')
    extendWindow(window)
    return window
  }

  async function openEntity (entity) {
    bot.activateEntity(entity)
    const [window] = await once(bot, 'windowOpen')
    extendWindow(window)
    return window
  }

  function updateHeldItem () {
    bot.emit('heldItemChanged', bot.heldItem)
  }

  // Pre-1.17 servers keep the player inventory's slot bookkeeping from before
  // the container opened until their next tick or an accepted click on it;
  // until then a change to a slot the container touched (e.g. by /clear) is
  // never sent. A rejected click already carries the full inventory, so the
  // sync click's outcome is not an error.
  function closeWindow (window) {
    dispatch({ type: 'closeWindow', window })
    if (config.stateIdUsed) return Promise.resolve()
    return clickWindow(-999, 0, 0).catch(() => {})
  }

  function tradeMatch (limitItem, targetItem) {
    return (
      targetItem !== null &&
      limitItem !== null &&
      targetItem.type === limitItem.type &&
      targetItem.count >= limitItem.count
    )
  }

  function expectTradeUpdate (window) {
    const trade = window.selectedTrade
    const hasItem = !!window.slots[2]

    // The result slot is present iff every input is satisfied.
    const satisfied = tradeMatch(trade.inputItem1, window.slots[0]) &&
      (!trade.hasItem2 || tradeMatch(trade.inputItem2, window.slots[1]))
    return hasItem !== satisfied
  }

  async function waitForWindowUpdate (window, slot) {
    // The server recomputes the crafting result slot after any click in the
    // crafting area, including picking up the result (which consumes the
    // ingredients). Waiting for that resync on result clicks too keeps
    // follow-up clicks and close_window from racing ahead of the craft.
    if (window.type === 'minecraft:inventory') {
      if (slot >= 0 && slot <= 4) {
        await once(bot.inventory, 'updateSlot:0')
      }
    } else if (window.type === 'minecraft:crafting') {
      if (slot >= 0 && slot <= 9) {
        await once(bot.currentWindow, 'updateSlot:0')
      }
    } else if (window.type === 'minecraft:merchant') {
      const toUpdate = []
      if (slot <= 1 && !window.selectedTrade.tradeDisabled && expectTradeUpdate(window)) {
        toUpdate.push(once(bot.currentWindow, 'updateSlot:2'))
      }
      if (slot === 2) {
        for (const item of bot.currentWindow.containerItems()) {
          toUpdate.push(once(bot.currentWindow, `updateSlot:${item.slot}`))
        }
      }
      await Promise.all(toUpdate)

      if (slot === 2 && !window.selectedTrade.tradeDisabled && expectTradeUpdate(window)) {
        // After the trade goes through, if the inputs are still satisfied,
        // expect another update in slot 2
        await once(bot.currentWindow, 'updateSlot:2')
      }
    }
  }

  function getChangedSlots (oldSlots, newSlots) {
    assert.equal(oldSlots.length, newSlots.length)

    const changedSlots = []

    for (let i = 0; i < newSlots.length; i++) {
      if (!Item.equal(oldSlots[i], newSlots[i])) {
        changedSlots.push(i)
      }
    }

    return changedSlots
  }

  // Applies a click to the window as 1.17+ clients do before sending it, and returns the slots it
  // changed. WHEN ADDING SUPPORT FOR OTHER CLICKS, MAKE SURE TO CHANGE changedSlots TO SUPPORT THEM
  function predictClick (window, click) {
    if (
    // this array indicates the clicks that return changedSlots
      [
        0,
        // 1,
        // 2,
        3,
        4
        // 5,
        // 6
      ].includes(click.mode)) {
      return window.acceptClick(click)
    }
    // this is used as a fallback
    const oldSlots = JSON.parse(JSON.stringify(window.slots))

    window.acceptClick(click)

    return getChangedSlots(oldSlots, window.slots)
  }

  async function clickWindow (slot, mouseButton, mode) {
    // if you click on the quick bar and have dug recently,
    // wait a bit
    if (slot >= bot.QUICK_BAR_START && bot.lastDigTime != null) {
      let timeSinceLastDig
      while ((timeSinceLastDig = new Date() - bot.lastDigTime) < DIG_CLICK_TIMEOUT) {
        await sleep(DIG_CLICK_TIMEOUT - timeSinceLastDig)
      }
    }

    const request = {}
    dispatch({ type: 'click', slot, mouseButton, mode, request })
    const { window } = request

    if (config.transactionPacketExists) {
      const [success] = await withTimeout(request.response, WINDOW_TIMEOUT)
        .catch(() => {
          throw new Error(`Server didn't respond to transaction for clicking on slot ${slot} on window with id ${window?.id}.`)
        })
      if (!success) {
        throw new Error(`Server rejected transaction for clicking on slot ${slot}, on window with id ${window?.id}.`)
      }
    } else {
      await waitForWindowUpdate(window, slot)
    }
  }

  async function putAway (slot) {
    const window = bot.currentWindow || bot.inventory
    const promisePutAway = once(window, `updateSlot:${slot}`)
    const start = window.inventoryStart
    const end = window.inventoryEnd
    const item = window.slots[slot]
    // A shift click on a result slot repeats the craft or trade while the
    // inputs cover it, and does nothing when the inventory has no room.
    const resultSlot = slot === window.craftingResultSlot || (window.type === 'minecraft:merchant' && slot === 2)
    const room = item && (window.findItemRange(start, end, item.type, item.metadata, true, item.nbt) || window.firstEmptySlotRange(start, end) !== null)
    if (room && !resultSlot) {
      await clickWindow(slot, 0, 1)
    } else {
      await clickWindow(slot, 0, 0)
      await putSelectedItemRange(start, end, window, null)
    }
    await promisePutAway
  }

  async function moveSlotItem (sourceSlot, destSlot) {
    await clickWindow(sourceSlot, 0, 0)
    await clickWindow(destSlot, 0, 0)
    // if we're holding an item, put it back where the source item was.
    // otherwise we're done.
    updateHeldItem()
    if (bot.inventory.selectedItem) {
      await clickWindow(sourceSlot, 0, 0)
    }
  }

  // A serverbound held_item_slot goes out iff bot.quickBarSlot differs from the slot the server
  // holds, whichever side selected the slot
  bot._ensureHasSentCarriedItem = () => dispatch({ type: 'ensureCarriedItemSent' })

  bot._setSlot = (slotId, newItem, window = bot.inventory) => {
    // set slot
    const oldItem = window.slots[slotId]
    window.updateSlot(slotId, newItem)
    updateHeldItem()
    bot.emit(`setSlot:${window.id}`, oldItem, newItem)
  }

  // 1.17.1+ servers only answer a click when their record of the client is
  // stale, so a click they ignored is never reported. A no-op click carrying
  // an impossible stateId always gets the full window state back.
  async function syncWindow (window) {
    if (!config.stateIdUsed) return
    const synced = once(bot, `setWindowItems:${window.id}`)
    dispatch({ type: 'resyncWindow', window })
    await synced
  }
  bot._syncWindow = syncWindow

  bot.activateBlock = activateBlock
  bot.activateEntity = activateEntity
  bot.activateEntityAt = activateEntityAt
  bot.consume = consume
  bot.activateItem = activateItem
  bot.deactivateItem = deactivateItem

  // not really in the public API
  bot.clickWindow = clickWindow
  bot.putSelectedItemRange = putSelectedItemRange
  bot.putAway = putAway
  bot.closeWindow = closeWindow
  bot.transfer = transfer
  bot.openBlock = openBlock
  bot.openEntity = openEntity
  bot.moveSlotItem = moveSlotItem
  bot.updateHeldItem = updateHeldItem
}
