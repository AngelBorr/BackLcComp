import ExchangeRateService from '../services/exchangeRate.service.js'

const publicExchangeRateDto = (quote) => ({
  source: quote.source,
  quoteType: quote.quoteType,
  baseCurrency: quote.baseCurrency,
  quoteCurrency: quote.quoteCurrency,
  rate: quote.rate,
  sourceDate: quote.sourceDate,
  sourceUpdatedTime: quote.sourceUpdatedTime
})

class CommerceController {
  constructor({ exchangeRateService = ExchangeRateService } = {}) {
    this.exchangeRateService = exchangeRateService
    this.getExchangeRate = this.getExchangeRate.bind(this)
  }

  async getExchangeRate(_req, res) {
    try {
      const quote = await this.exchangeRateService.getUsdArsSellingQuote()
      return res.status(200).json(publicExchangeRateDto(quote))
    } catch {
      return res.status(503).json({
        status: 'unavailable',
        message: 'Cotización temporalmente no disponible'
      })
    }
  }
}

export { CommerceController, publicExchangeRateDto }
export default new CommerceController()
