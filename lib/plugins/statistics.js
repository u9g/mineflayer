module.exports = inject

function inject (bot) {
  function requestStatistics () {
    return new Promise(function (resolve, reject) {
      bot._client.write('client_command', { actionId: 1 })
      bot._client.once('statistics', parseStatistics)

      function parseStatistics (packet) {
        let parsedPacket = {}

        packet.entries.forEach(function (statistic) {
          parsedPacket[statistic.name] = statistic.value
        })

        bot._client.removeListener('statistics', parseStatistics)
        resolve(parsedPacket)
      }
    })
  }

  bot.requestStatistics = requestStatistics
}