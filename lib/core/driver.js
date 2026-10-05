// Connects a sans-io core (see ./health.js) and its codec (see ./healthCodec.js) to a bot:
// decodes the codec's packets into core events, and performs the core's outputs.
//
// Outputs are performed in order after `step` returns, so listeners always see the core's
// state fully updated. A listener that dispatches a command re-enters `dispatch`, and that
// command's outputs are performed before the rest of the batch, like a nested synchronous call.
//
// `send` writes a packet; Bedrock plugins pass bot._client.queue to batch with the rest of the tick.

function createDriver (bot, { step, config, state, codec, send = (name, data) => bot._client.write(name, data) }) {
  const timers = new Map()

  function dispatch (event) {
    for (const output of step(config, state, event)) {
      if (output.type === 'emit') bot.emit(output.event, ...output.args)
      else if (output.type === 'setTimer') setTimer(output.name, output.ms)
      else if (output.type === 'clearTimer') clearTimer(output.name)
      else for (const { name, data } of codec.encode(output)) send(name, data)
    }
  }

  function setTimer (name, ms) {
    clearTimer(name)
    timers.set(name, setTimeout(() => {
      timers.delete(name)
      dispatch({ type: 'timer', name })
    }, ms))
  }

  function clearTimer (name) {
    clearTimeout(timers.get(name))
    timers.delete(name)
  }

  function listen () {
    for (const name of codec.packets) {
      bot._client.on(name, (data) => {
        const event = codec.decode(name, data)
        if (event) dispatch(event)
      })
    }
  }

  // Cancels pending timers, for when the connection closes
  function stop () {
    for (const name of [...timers.keys()]) clearTimer(name)
  }

  // Exposes state[key] as bot[key]. A plain read-write property, as before, so user code
  // that assigns it (for instance in tests) keeps working.
  function exposeState (keys) {
    for (const key of keys) {
      Object.defineProperty(bot, key, {
        get: () => state[key],
        set: (value) => { state[key] = value },
        enumerable: true,
        configurable: true
      })
    }
  }

  return { dispatch, listen, stop, exposeState }
}

module.exports = { createDriver }
