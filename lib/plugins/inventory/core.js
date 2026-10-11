// Inventory, windows, window clicks and held items as a sans-io state machine:
// step(config, state, event) -> outputs. ./codec.js turns packets into events and outputs into
// packets, and ./index.js connects both to the bot.
//
// The windows themselves are prismarine-windows objects, which hold the slots and work out what
// a click does. The core creates them and reads them, but never changes one: a window is an event
// emitter that user code listens to, so every change to one is an output that ./index.js performs
// (see `effects` in lib/sansio/driver.js). Items in packets stay in their wire form here, and
// ./index.js decodes each where it is applied, so no two slots share one item.
//
// Events from packets:
//   { type: 'entityStatus', entityId, status }
//   { type: 'cooldown', itemId }
//   { type: 'transaction', windowId, actionId, accepted }      before 1.17
//   { type: 'login' }, { type: 'respawned' }
//   { type: 'heldItemSlot', slot }
//   { type: 'windowOpened', windowId, windowType, title, slotCount }
//   { type: 'horseWindowOpened', windowId, slotCount }
//   { type: 'windowClosedByServer' }
//   { type: 'setSlot', windowId, slot, item, stateId }
//   { type: 'setPlayerInventorySlot', slot, item }               slot as a window 0 slot
//   { type: 'windowItems', windowId, items, carriedItem, stateId }
// Events from the bot:
//   { type: 'heldItemChanged', item }, { type: 'inventorySlotUpdated', index }
//   { type: 'click', slot, mouseButton, mode, request }
//   { type: 'clickPredicted', click, window, changedSlots }
//   { type: 'closeWindow', window }, { type: 'resyncWindow', window }
//   { type: 'ensureCarriedItemSent' }
//   { type: 'consume', gameMode, food, entity, request }
//   { type: 'activateItem', offHand, entity }, { type: 'deactivateItem' }
//   { type: 'useItemOn', position, face, cursor }
//   { type: 'interactEntity', entity }, { type: 'interactEntityAt', entity, position }
// Outputs for ./codec.js to send:
//   windowClick, resyncWindow, acceptTransaction, closeWindow, setCarriedItem, useItem,
//   releaseUseItem, useItemOn, interactEntity, interactEntityAt
// Outputs ./index.js performs (effects):
//   setSlot, setWindowItems, copySlot, predictClick, acceptClick, clickSent, extendWindow,
//   updateHeldItem, eatingStarted, eatingFinished, eatingCancelled, consumeRefused
// and { type: 'emit', event, args }, a bot event.
//
// A command whose caller needs an answer carries a `request` object, which the core only passes
// on in the output that answers it (clickSent, consumeRefused). A listener can start another
// click while one is being sent, so the answer can't be kept in the state.

const assert = require('assert')

const ALWAYS_CONSUMABLES = [
  'potion',
  'milk_bucket',
  'enchanted_golden_apple',
  'golden_apple'
]

// createWindow(id, type, title, slotCount) makes a prismarine-windows window, itemsEqual is
// prismarine-item's Item.equal, and ownEntityId() reads the bot's entity id from the entities plugin
function createConfig ({ stateIdUsed, transactionPacketExists, createWindow, itemsEqual, ownEntityId }) {
  return Object.freeze({ stateIdUsed, transactionPacketExists, createWindow, itemsEqual, ownEntityId })
}

function createState (config) {
  return {
    inventory: config.createWindow(0, 'minecraft:inventory', 'Inventory'),
    currentWindow: null,
    // 0-8, null = uninitialized: which quick bar slot is selected
    quickBarSlot: null,
    usingHeldItem: false,
    // Slot the server holds as this client's selection; 0 after every login
    carriedIndex: 0,
    nextActionNumber: 0, // < 1.17
    stateId: -1, // 1.17.1+
    // Clicks sent and not yet confirmed by a transaction packet, oldest first (< 1.17)
    pendingClicks: [],
    // A window_items for a window that is not open yet
    bufferedWindowItems: null,
    // The last window we closed client-side. The server applies our close_window on a later
    // tick and keeps syncing slots through the old windowId until then; those trailing packets
    // still describe the player inventory (routed through the window's inventory region).
    lastClosedWindow: null,
    // Windows opened before their slots arrived, so not announced yet
    windowsAwaitingItems: [],
    eating: false,
    previousHeldItem: null
  }
}

function heldItem (state) {
  return state.inventory.slots[state.inventory.hotbarStart + state.quickBarSlot]
}

function step (config, state, event) {
  const out = []
  const handler = handlers[event.type]
  if (handler) handler(config, state, event, out)
  return out
}

const handlers = {
  entityStatus (config, state, { entityId, status }, out) {
    if (entityId === config.ownEntityId() && status === 9 && state.eating) finishEating(state, out)
    state.usingHeldItem = false
  },

  heldItemChanged (config, state, { item }, out) {
    const previous = state.previousHeldItem
    // we only disable the item if the item type or count changes
    if (item?.type === previous?.type && item?.count === previous?.count) {
      state.previousHeldItem = item
      return
    }
    if (state.eating) finishEating(state, out)
    state.usingHeldItem = false
  },

  cooldown (config, state, { itemId }, out) {
    const held = heldItem(state)
    if (held && held.type !== itemId) return
    if (state.eating) finishEating(state, out)
    state.usingHeldItem = false
  },

  consume (config, state, { gameMode, food, entity, request }, out) {
    if (state.eating) {
      state.eating = false
      out.push({ type: 'eatingCancelled', message: 'Consuming cancelled due to calling bot.consume() again' })
    }
    const held = heldItem(state)
    if (gameMode !== 'creative') {
      if (!held) {
        out.push({ type: 'consumeRefused', request, message: 'Nothing to consume: no item is held' })
        return
      }
      if (!ALWAYS_CONSUMABLES.includes(held.name) && food === 20) {
        out.push({ type: 'consumeRefused', request, message: 'Food is full' })
        return
      }
    }
    state.eating = true
    out.push({ type: 'eatingStarted' })
    activateItem(state, false, entity, out)
  },

  activateItem (config, state, { offHand, entity }, out) {
    activateItem(state, offHand, entity, out)
  },

  deactivateItem (config, state, event, out) {
    out.push({ type: 'releaseUseItem' })
    state.usingHeldItem = false
  },

  useItemOn (config, state, { position, face, cursor }, out) {
    out.push({ type: 'useItemOn', position, face, cursor, heldItem: heldItem(state) })
  },

  interactEntity (config, state, { entity }, out) {
    out.push({ type: 'interactEntity', entity })
  },

  interactEntityAt (config, state, { entity, position }, out) {
    out.push({ type: 'interactEntityAt', entity, position })
  },

  click (config, state, { slot, mouseButton, mode, request }, out) {
    const window = state.currentWindow || state.inventory
    assert.ok(mode >= 0 && mode <= 6)
    state.nextActionNumber = state.nextActionNumber === 32767 ? 1 : state.nextActionNumber + 1
    const click = {
      slot,
      mouseButton,
      mode,
      id: state.nextActionNumber,
      windowId: window.id,
      item: slot === -999 ? null : window.slots[slot]
    }

    if (config.transactionPacketExists) {
      state.pendingClicks.push(click)
      out.push(windowClick(state, window, click))
      out.push({ type: 'clickSent', request, click, window })
      // A click the server never answers is confirmed here, once the bot is listening for it
      if (!window.transactionRequiresConfirmation(click)) confirmTransaction(state, window.id, click.id, true, out)
    } else {
      // 1.17+ clients apply a click themselves, then send it with the slots it changed
      // (clickPredicted)
      out.push({ type: 'predictClick', click, window })
      out.push({ type: 'clickSent', request, click, window })
    }
  },

  clickPredicted (config, state, { click, window, changedSlots }, out) {
    out.push(windowClick(state, window, click, {
      changedSlots: changedSlots.map(slot => ({ location: slot, item: window.slots[slot] })),
      cursorItem: window.selectedItem
    }))
  },

  transaction (config, state, { windowId, actionId, accepted }, out) {
    confirmTransaction(state, windowId, actionId, accepted, out)
  },

  // Pre-1.17 servers keep the player inventory's slot bookkeeping from before the container
  // opened until their next tick or an accepted click on it; ./index.js follows this with a
  // click there.
  closeWindow (config, state, { window }, out) {
    out.push({ type: 'closeWindow', windowId: window.id })
    copyInventory(config, state, window, out)
    state.lastClosedWindow = window
    state.currentWindow = null
    out.push(emit('windowClose', window))
  },

  // 1.17.1+ servers only answer a click when their record of the client is stale, so a click
  // they ignored is never reported. A no-op click carrying an impossible stateId always gets
  // the full window state back. Only sent on 1.17.1+; ./index.js doesn't ask before.
  resyncWindow (config, state, { window }, out) {
    out.push({ type: 'resyncWindow', windowId: window.id, cursorItem: window.selectedItem })
  },

  // A serverbound held_item_slot goes out iff quickBarSlot differs from carriedIndex, whichever
  // side selected the slot
  ensureCarriedItemSent (config, state, event, out) {
    ensureCarriedItemSent(state, out)
  },

  // A server-sent slot outside the hotbar is ignored
  heldItemSlot (config, state, { slot }, out) {
    if (slot < 0 || slot >= 9) return
    const changed = slot !== state.quickBarSlot
    state.quickBarSlot = slot
    ensureCarriedItemSent(state, out)
    if (changed) out.push({ type: 'updateHeldItem' })
  },

  windowOpened (config, state, { windowId, windowType, title, slotCount }, out) {
    state.lastClosedWindow = null
    state.currentWindow = config.createWindow(windowId, windowType, title, slotCount)
    prepareWindow(state, state.currentWindow, out)
  },

  horseWindowOpened (config, state, { windowId, slotCount }, out) {
    state.currentWindow = config.createWindow(windowId, 'HorseWindow', 'Horse', slotCount)
    prepareWindow(state, state.currentWindow, out)
  },

  windowClosedByServer (config, state, event, out) {
    const oldWindow = state.currentWindow
    state.currentWindow = null
    out.push(emit('windowClose', oldWindow))
  },

  // A respawn (death or dimension change) replaces the server-side player entity and resets its
  // window id counter, so pending window state can never describe a post-respawn window, and a
  // later window can reuse the closed one's id
  respawned (config, state, event, out) {
    state.lastClosedWindow = null
    state.bufferedWindowItems = null
  },

  login (config, state, event, out) {
    state.carriedIndex = 0
    // close window when switching subserver
    state.lastClosedWindow = null
    state.bufferedWindowItems = null
    const oldWindow = state.currentWindow
    if (!oldWindow) return
    state.currentWindow = null
    out.push(emit('windowClose', oldWindow))
  },

  setSlot (config, state, { windowId, slot, item, stateId }, out) {
    if (config.stateIdUsed) state.stateId = stateId
    const window = windowId === 0 ? state.inventory : state.currentWindow
    if (!window || window.id !== windowId) {
      // Trailing sync for a window we already closed client-side. Slots in its player-inventory
      // region still describe the inventory: apply them or the model keeps items the server has
      // since moved.
      const closed = state.lastClosedWindow
      if (closed && windowId === closed.id && slot >= closed.inventoryStart && slot < closed.inventoryEnd) {
        out.push(setSlot(state.inventory, slot - (closed.inventoryStart - state.inventory.inventoryStart), item))
      }
      return
    }
    out.push(setSlot(window, slot, item))
  },

  setPlayerInventorySlot (config, state, { slot, item }, out) {
    out.push(setSlot(state.inventory, slot, item))
  },

  windowItems (config, state, event, out) {
    const { windowId, items, carriedItem, stateId } = event
    if (config.stateIdUsed) state.stateId = stateId
    const window = windowId === 0 ? state.inventory : state.currentWindow
    if (!window || window.id !== windowId) {
      // Buffer even when the id matches a just-closed window: villager windows send window_items
      // before open_window, and their id can collide with lastClosedWindow's because a respawn
      // replaces the server-side player entity and restarts its window id counter.
      state.bufferedWindowItems = event
      // Trailing sync for a window we already closed client-side: apply its player-inventory
      // region (see setSlot). The item count identifies the window shape: an early sync for a
      // different window type must not be routed through the closed window's slot mapping.
      const closed = state.lastClosedWindow
      if (closed && windowId === closed.id && items.length === closed.slots.length) {
        for (let i = closed.inventoryStart; i < closed.inventoryEnd && i < items.length; i++) {
          out.push(setSlot(state.inventory, i - (closed.inventoryStart - state.inventory.inventoryStart), items[i]))
        }
      }
      return
    }

    out.push({ type: 'setWindowItems', window, items, carriedItem })
    out.push({ type: 'updateHeldItem' })
    // don't emit windowOpen until we have the slot data
    for (const awaiting of state.windowsAwaitingItems.filter(w => w.id === windowId)) {
      out.push({ type: 'extendWindow', window: awaiting }, emit('windowOpen', awaiting))
    }
    state.windowsAwaitingItems = state.windowsAwaitingItems.filter(w => w.id !== windowId)
    out.push(emit(`setWindowItems:${window.id}`))
  },

  inventorySlotUpdated (config, state, { index }, out) {
    if (index === state.quickBarSlot + state.inventory.hotbarStart) out.push({ type: 'updateHeldItem' })
  }
}

function finishEating (state, out) {
  state.eating = false
  out.push({ type: 'eatingFinished' })
}

function activateItem (state, offHand, entity, out) {
  // use_item must not be sent for an empty hand
  if (!(offHand ? state.inventory.slots[45] : heldItem(state))) return
  state.usingHeldItem = true
  out.push({ type: 'useItem', offHand, heldItem: heldItem(state), entity })
}

function windowClick (state, window, click, predicted = {}) {
  return {
    type: 'windowClick',
    windowId: window.id,
    stateId: state.stateId,
    slot: click.slot,
    mouseButton: click.mouseButton,
    mode: click.mode,
    actionId: click.id,
    item: click.item,
    ...predicted
  }
}

function confirmTransaction (state, windowId, actionId, accepted, out) {
  // drop the queue entries for all the clicks that the server did not send transaction packets
  // for. Also reject transactions that aren't sent from mineflayer
  const queue = state.pendingClicks
  let click = queue[0]
  if (click === undefined || !queue.some(clicks => clicks.id === actionId)) {
    // mimic vanilla client and send a rejection for faulty transaction packets
    out.push({ type: 'acceptTransaction', windowId, actionId })
    return
  }
  // shift it later if packets are sent out of order
  click = queue.shift()

  assert.ok(click.id <= actionId)
  while (actionId > click.id) {
    onAccepted()
    click = queue.shift()
  }
  assert.ok(click)

  if (accepted) {
    onAccepted()
  } else {
    out.push({ type: 'acceptTransaction', windowId: click.windowId, actionId: click.id })
    out.push(emit(`confirmTransaction${click.id}`, false))
  }
  out.push({ type: 'updateHeldItem' })

  function onAccepted () {
    const window = windowId === 0 ? state.inventory : state.currentWindow
    if (!window || window.id !== click.windowId) return
    out.push({ type: 'acceptClick', window, click })
    out.push(emit(`confirmTransaction${click.id}`, true))
  }
}

function ensureCarriedItemSent (state, out) {
  if (state.quickBarSlot === state.carriedIndex) return
  state.carriedIndex = state.quickBarSlot
  out.push({ type: 'setCarriedItem', slot: state.carriedIndex })
}

function prepareWindow (state, window, out) {
  const buffered = state.bufferedWindowItems
  if (!buffered || window.id !== buffered.windowId) {
    // announced once its window_items arrives
    state.windowsAwaitingItems.push(window)
    return
  }
  out.push({ type: 'setWindowItems', window, items: buffered.items })
  // consume the buffer so a later window reusing this id cannot open with stale contents
  state.bufferedWindowItems = null
  out.push({ type: 'updateHeldItem' })
  out.push({ type: 'extendWindow', window }, emit('windowOpen', window))
}

function copyInventory (config, state, window, out) {
  const inventory = state.inventory
  const slotOffset = window.inventoryStart - inventory.inventoryStart
  for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
    const item = window.slots[i]
    const slot = i - slotOffset
    out.push({ type: 'copySlot', item, slot, changed: !config.itemsEqual(inventory.slots[slot], item, true) })
  }
}

// item is in its wire form, for ./index.js to decode where it is applied
function setSlot (window, slot, item) {
  return { type: 'setSlot', window, slot, item }
}

function emit (event, ...args) { return { type: 'emit', event, args } }

module.exports = { createConfig, createState, step, heldItem }
