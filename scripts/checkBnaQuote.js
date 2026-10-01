import BnaExchangeRateProvider from '../src/providers/bnaExchangeRate.provider.js'

try {
  const quote = await BnaExchangeRateProvider.getUsdArsSellingQuote()
  process.stdout.write(`${JSON.stringify(quote, null, 2)}\n`)
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: error?.code || 'BNA_QUOTE_UNAVAILABLE',
      message: error?.message || 'No se pudo obtener la cotización BNA'
    })}\n`
  )
  process.exitCode = 1
}
