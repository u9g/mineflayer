// The health core (./health.js) compiled from Valen (./valen/health.vale) to Wasm, behind the
// same createConfig, createState and step, so the driver and plugin can use either one.
//
// The state stays a plain JS object, so exposeState and user assignments work unchanged: each
// event passes in the fields the Valen core decides on, and the core's externs (below) collect
// its outputs and new state. The health, food and saturation it reports are the update's own
// values, copied here.

const fs = require('fs')
const path = require('path')
const { createConfig, createState } = require('./health')

// The step in progress, which the core's externs write to
let current

// health.vale's extern funcs, imported from "env" under their C names
const externs = {
  health_clientLoaded: () => current.out.push({ type: 'clientLoaded' }),
  health_requestRespawn: () => current.out.push({ type: 'requestRespawn' }),
  health_emitHealth: () => current.out.push(emit('health')),
  health_emitDeath: () => current.out.push(emit('death')),
  health_emitSpawn: () => current.out.push(emit('spawn')),
  health_emitRespawn: () => current.out.push(emit('respawn')),
  health_setState: (isAlive, receivedHealth) => {
    current.state.isAlive = isAlive !== 0
    current.state.receivedHealth = receivedHealth !== 0
  }
}

let loaded
function wasm () {
  if (!loaded) loaded = instantiate(fs.readFileSync(path.join(__dirname, 'health.wasm')))
  return loaded
}

// Synchronous, so the plugin can load it inside inject. The core does no IO; only a Valen panic
// reaches WASI, so those imports just report it.
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
  const imports = { env: {} }
  for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== 'function') continue
    if (from === 'env') {
      if (!externs[name]) throw new Error(`health.wasm imports ${name}, which healthWasm.js doesn't provide`)
      imports.env[name] = externs[name]
    } else {
      imports[from] ??= {}
      imports[from][name] = (from === 'wasi_snapshot_preview1' && wasi[name]) ||
        (() => { throw new Error(`health.wasm called unsupported import ${from}.${name}`) })
    }
  }
  const instance = new WebAssembly.Instance(module, imports)
  instance.exports._initialize?.()
  return instance.exports
}

function step (config, state, event) {
  const core = wasm()
  const out = []
  current = { state, out }
  try {
    const args = [config.autoRespawn, state.isAlive, state.receivedHealth]
    if (event.type === 'healthUpdate') {
      state.health = event.health
      state.food = event.food
      state.foodSaturation = event.foodSaturation
      core.health_healthUpdate(...args, event.health)
    } else if (event.type === 'respawned') {
      core.health_respawned(...args)
    } else if (event.type === 'respawnCommand') {
      core.health_respawnCommand(...args)
    }
  } finally {
    current = undefined
  }
  return out
}

function emit (event, ...args) { return { type: 'emit', event, args } }

module.exports = { createConfig, createState, step }
