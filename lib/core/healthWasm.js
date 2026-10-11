// The health core (./health.js) compiled from Valen (./valen/health.vale) to Wasm, behind the
// same createConfig, createState and step, so the driver and plugin can use either one.
//
// The state stays a plain JS object, so exposeState and user assignments work unchanged: each
// step passes in the fields the Valen core decides on and writes back what it returns. The
// health, food and saturation it reports are the update's own values, copied here.

const fs = require('fs')
const path = require('path')
const { createConfig, createState } = require('./health')

const eventCodes = { healthUpdate: 1, respawned: 2, respawnCommand: 3 }
const outputsByCode = [
  null,
  () => ({ type: 'clientLoaded' }),
  () => ({ type: 'requestRespawn' }),
  () => emit('health'),
  () => emit('death'),
  () => emit('spawn'),
  () => emit('respawn')
]

let loaded
function wasm () {
  if (!loaded) loaded = instantiate(fs.readFileSync(path.join(__dirname, 'health.wasm')))
  return loaded
}

// Synchronous, so the plugin can load it inside inject. The core does no IO; only a Valen panic
// reaches WASI, so these imports just report it.
function instantiate (bytes) {
  const module = new WebAssembly.Module(bytes)
  const wasi = {
    fd_write (fd, iovs, iovsLen, written) {
      const { memory } = instance.exports
      const view = new DataView(memory.buffer)
      let total = 0
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true)
        const len = view.getUint32(iovs + i * 8 + 4, true)
        process.stderr.write(Buffer.from(memory.buffer, ptr, len))
        total += len
      }
      view.setUint32(written, total, true)
      return 0
    },
    proc_exit (code) { throw new Error(`health.wasm exited with code ${code}`) }
  }
  const imports = {}
  for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== 'function') continue
    imports[from] ??= {}
    imports[from][name] = (from === 'wasi_snapshot_preview1' && wasi[name]) ||
      (() => { throw new Error(`health.wasm called unsupported import ${from}.${name}`) })
  }
  const instance = new WebAssembly.Instance(module, imports)
  instance.exports._initialize?.()
  return instance.exports
}

function step (config, state, event) {
  const result = wasm().step(
    config.autoRespawn ? 1 : 0,
    state.isAlive ? 1 : 0,
    state.receivedHealth ? 1 : 0,
    eventCodes[event.type] ?? 0,
    event.health ?? 0
  )
  if (event.type === 'healthUpdate') {
    state.health = event.health
    state.food = event.food
    state.foodSaturation = event.foodSaturation
  }
  state.isAlive = (result & 1) === 1
  state.receivedHealth = (result & 2) === 2

  const out = []
  for (let codes = result >>> 2; codes !== 0; codes >>>= 3) out.push(outputsByCode[codes & 7]())
  return out
}

function emit (event, ...args) { return { type: 'emit', event, args } }

module.exports = { createConfig, createState, step }
