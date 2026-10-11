// The packet format of the inventory core (./core.js) for one version: decodes clientbound
// packets into core events and encodes core outputs into serverbound packets. All version
// differences in packet names and fields live here; the core only sees the events listed in
// ./core.js.
//
// Items in clientbound packets are left in their wire form: ./index.js decodes each with
// decodeItem where it is applied.

const assert = require('assert')
const { Vec3 } = require('vec3')
const { toNotchianYaw, toNotchianPitch } = require('../../conversions')

// Item and ChatMessage are prismarine-item and prismarine-chat for the bot's registry.
// nextSequence is the block prediction sequence shared with other plugins (lib/plugins/sequence.js),
// taken only by the packets that send it.
function createCodec (supportFeature, { Item, ChatMessage, nextSequence }) {
  const stateIdUsed = !!supportFeature('stateIdUsed') // 1.17.1+
  const actionIdUsed = !!supportFeature('actionIdUsed') // < 1.17
  const quickMoveClickSendsEmptyItem = !!supportFeature('quickMoveClickSendsEmptyItem')
  const useItemWithBlockPlace = !!supportFeature('useItemWithBlockPlace')
  const useItemWithOwnPacket = !!supportFeature('useItemWithOwnPacket')
  const blockPlaceHasHeldItem = !!supportFeature('blockPlaceHasHeldItem')
  const blockPlaceHasHandAndIntCursor = !!supportFeature('blockPlaceHasHandAndIntCursor')
  const blockPlaceHasHandAndFloatCursor = !!supportFeature('blockPlaceHasHandAndFloatCursor')
  const blockPlaceHasInsideBlock = !!supportFeature('blockPlaceHasInsideBlock')

  const decoders = {
    entity_status: (data) => ({ type: 'entityStatus', entityId: data.entityId, status: data.entityStatus }),
    set_cooldown: (data) => ({ type: 'cooldown', itemId: data.itemID }),
    transaction: (data) => ({ type: 'transaction', windowId: data.windowId, actionId: data.action, accepted: data.accepted }),
    login: () => ({ type: 'login' }),
    held_item_slot: (data) => ({ type: 'heldItemSlot', slot: data.slot }),
    // The title is a chat component whose wire shape depends on the version (JSON string, or an
    // NBT string/compound); window.title is always a ChatMessage.
    open_window: (data) => ({
      type: 'windowOpened',
      windowId: data.windowId,
      windowType: data.inventoryType,
      title: ChatMessage.fromNotch(data.windowTitle),
      slotCount: data.slotCount
    }),
    open_horse_window: (data) => ({ type: 'horseWindowOpened', windowId: data.windowId, slotCount: data.nbSlots }),
    close_window: () => ({ type: 'windowClosedByServer' }),
    respawn: () => ({ type: 'respawned' }),
    set_slot: (data) => ({ type: 'setSlot', windowId: data.windowId, slot: data.slot, item: data.item, stateId: data.stateId }),
    // 1.21.9+ uses set_player_inventory for server-initiated inventory changes (e.g. console
    // /give) instead of set_slot
    set_player_inventory: (data) => ({ type: 'setPlayerInventorySlot', slot: playerInventorySlotToWindow(data.slotId), item: data.contents }),
    window_items: (data) => ({
      type: 'windowItems',
      windowId: data.windowId,
      items: data.items,
      carriedItem: data.carriedItem,
      stateId: data.stateId
    })
  }

  const encoders = {
    windowClick (output) {
      const { windowId, stateId, slot, mouseButton, mode, actionId, item } = output
      // changedSlots and cursorItem are only set from 1.17, which applies clicks itself
      const changedSlots = output.changedSlots?.map(({ location, item }) => ({ location, item: Item.toNotch(item) }))
      if (stateIdUsed) { // 1.17.1+
        return { windowId, stateId, slot, mouseButton, mode, changedSlots, cursorItem: Item.toNotch(output.cursorItem) }
      }
      if (actionIdUsed) { // <= 1.16.5
        // Must match what the server's own click handling returns.
        const sendsEmptyItem = mode === 2 || mode === 4 || (mode === 1 && quickMoveClickSendsEmptyItem)
        return { windowId, slot, mouseButton, action: actionId, mode, item: Item.toNotch(sendsEmptyItem ? null : item) }
      }
      // 1.17
      return { windowId, slot, mouseButton, mode, changedSlots, cursorItem: Item.toNotch(output.cursorItem) }
    },

    resyncWindow ({ windowId, cursorItem }) {
      return {
        windowId,
        stateId: -1,
        slot: -999,
        mouseButton: 2, // end of a drag that never started
        mode: 5,
        changedSlots: [],
        cursorItem: Item.toNotch(cursorItem)
      }
    }
  }

  return {
    packets: Object.keys(decoders),

    decode (name, data) {
      const decoder = decoders[name]
      if (!decoder) throw new Error(`inventory codec can't decode ${name}`)
      return decoder(data)
    },

    decodeItem (item) {
      return Item.fromNotch(item)
    },

    // Returns the packets for an output, as { name, data }; none if this version has no such packet
    encode (output) {
      switch (output.type) {
        case 'windowClick':
          return [{ name: 'window_click', data: encoders.windowClick(output) }]
        case 'resyncWindow':
          return [{ name: 'window_click', data: encoders.resyncWindow(output) }]
        case 'acceptTransaction':
          return [{ name: 'transaction', data: { windowId: output.windowId, action: output.actionId, accepted: true } }]
        case 'closeWindow':
          return [{ name: 'close_window', data: { windowId: output.windowId } }]
        case 'setCarriedItem':
          return [{ name: 'held_item_slot', data: { slotId: output.slot } }]
        case 'useItem':
          return useItem(output)
        case 'releaseUseItem':
          return [{ name: 'block_dig', data: releaseUseItem() }]
        case 'useItemOn':
          return useItemOn(output)
        case 'interactEntity':
          return [{
            name: 'use_entity',
            data: {
              target: output.entity.id,
              mouse: 0, // interact with entity
              sneaking: false,
              hand: 0, // interact with the main hand
              location: new Vec3(0, 0, 0)
            }
          }]
        case 'interactEntityAt': {
          const { entity, position } = output
          return [{
            name: 'use_entity',
            data: {
              target: entity.id,
              mouse: 2, // interact with entity at
              sneaking: false,
              hand: 0, // interact with the main hand
              x: position.x - entity.position.x,
              y: position.y - entity.position.y,
              z: position.z - entity.position.z,
              location: position.subtract(entity.position)
            }
          }]
        }
      }
      throw new Error(`inventory codec can't encode ${output.type}`)
    }
  }

  function useItem ({ offHand, heldItem, entity }) {
    if (useItemWithBlockPlace) {
      return [{
        name: 'block_place',
        data: {
          location: new Vec3(-1, 255, -1),
          direction: -1,
          heldItem: Item.toNotch(heldItem),
          cursorX: -1,
          cursorY: -1,
          cursorZ: -1
        }
      }]
    }
    if (useItemWithOwnPacket) {
      return [{
        name: 'use_item',
        data: {
          hand: offHand ? 1 : 0,
          sequence: nextSequence(),
          rotation: {
            x: toNotchianYaw(entity.yaw),
            y: toNotchianPitch(entity.pitch)
          }
        }
      }]
    }
    return []
  }

  function releaseUseItem () {
    const body = {
      status: 5,
      location: new Vec3(0, 0, 0),
      face: 5
    }
    if (useItemWithOwnPacket) {
      body.face = 0
      body.sequence = 0
    }
    return body
  }

  // cursor is the point on the clicked face, from 0 to 1 within the block
  function useItemOn ({ position, face, cursor, heldItem }) {
    let data
    if (blockPlaceHasHeldItem) {
      data = {
        location: position,
        direction: face,
        heldItem: Item.toNotch(heldItem),
        cursorX: cursor.scaled(16).x,
        cursorY: cursor.scaled(16).y,
        cursorZ: cursor.scaled(16).z
      }
    } else if (blockPlaceHasHandAndIntCursor) {
      data = {
        location: position,
        direction: face,
        hand: 0,
        cursorX: cursor.scaled(16).x,
        cursorY: cursor.scaled(16).y,
        cursorZ: cursor.scaled(16).z
      }
    } else if (blockPlaceHasHandAndFloatCursor) {
      data = {
        location: position,
        direction: face,
        hand: 0,
        cursorX: cursor.x,
        cursorY: cursor.y,
        cursorZ: cursor.z
      }
    } else if (blockPlaceHasInsideBlock) {
      data = {
        location: position,
        direction: face,
        hand: 0,
        cursorX: cursor.x,
        cursorY: cursor.y,
        cursorZ: cursor.z,
        insideBlock: false,
        sequence: nextSequence(), // 1.19.0+
        worldBorderHit: false // 1.21.3+
      }
    } else {
      return []
    }
    return [{ name: 'block_place', data }]
  }
}

// set_player_inventory uses vanilla Inventory indices (0-8 hotbar, 9-35 main, 36-39 armor from
// feet to head, 40 offhand), not window 0 slot numbers (36-44 hotbar, 9-35 main, 5-8 armor from
// head to feet, 45 offhand)
function playerInventorySlotToWindow (slotId) {
  if (slotId <= 8) return slotId + 36 // hotbar
  if (slotId >= 36 && slotId <= 39) return 44 - slotId // armor
  if (slotId === 40) return 45 // offhand
  return slotId // main inventory
}

/**
 * Convert a vector direction to the face number packets use
 * @param {Vec3} v
 * @returns {number}
 */
function vectorToDirection (v) {
  if (v.y < 0) {
    return 0
  } else if (v.y > 0) {
    return 1
  } else if (v.z < 0) {
    return 2
  } else if (v.z > 0) {
    return 3
  } else if (v.x < 0) {
    return 4
  } else if (v.x > 0) {
    return 5
  }
  assert.ok(false, `invalid direction vector ${v}`)
}

module.exports = { createCodec, vectorToDirection }
