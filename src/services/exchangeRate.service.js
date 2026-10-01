import BnaExchangeRateProvider, {
  BnaExchangeRateProviderError
} from '../providers/bnaExchangeRate.provider.js'
import { ServiceError } from './service.products.js'
import { convertUsdToArs, normalizeDecimalString } from '../utils/commerceMoney.js'
import { error as logError, secureLog } from '../utils/logger.js'

const EXPECTED_QUOTE = Object.freeze({
  source: 'BNA',
  quoteType: 'billete_venta',
  baseCurrency: 'USD',
  quoteCurrency: 'ARS'
})

const normalizeQuote = (quote) => {
  if (!quote || Object.entries(EXPECTED_QUOTE).some(([field, value]) => quote[field] !== value)) {
    throw new ServiceError(
      'La cotización obtenida no corresponde a BNA Billete Venta USD/ARS',
      'BNA_QUOTE_INVALID',
      502
    )
  }

  let rate

  try {
    rate = normalizeDecimalString(quote.rate, 'rate')
  } catch {
    throw new ServiceError('BNA devolvió una cotización inválida', 'BNA_QUOTE_INVALID', 502)
  }

  if (BigInt(rate.replace('.', '')) <= 0n) {
    throw new ServiceError('BNA devolvió una cotización no positiva', 'BNA_QUOTE_INVALID', 502)
  }

  const sourceEffectiveAt = new Date(quote.sourceEffectiveAt)
  const fetchedAt = new Date(quote.fetchedAt)
  let sourceUrl

  try {
    sourceUrl = new URL(quote.sourceUrl)
  } catch {
    sourceUrl = null
  }

  const sourceHostname = sourceUrl?.hostname.toLowerCase()
  const isOfficialSource =
    sourceUrl?.protocol === 'https:' &&
    (sourceHostname === 'bna.com.ar' || sourceHostname?.endsWith('.bna.com.ar'))

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(quote.sourceDate)) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(quote.sourceUpdatedTime)) ||
    Number.isNaN(sourceEffectiveAt.getTime()) ||
    Number.isNaN(fetchedAt.getTime()) ||
    !isOfficialSource
  ) {
    throw new ServiceError(
      'La metadata de la cotización BNA es inválida',
      'BNA_QUOTE_INVALID',
      502
    )
  }

  return {
    ...EXPECTED_QUOTE,
    rate,
    sourceDate: quote.sourceDate,
    sourceUpdatedTime: quote.sourceUpdatedTime,
    sourceEffectiveAt: sourceEffectiveAt.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    sourceUrl: sourceUrl.toString()
  }
}

class ExchangeRateService {
  constructor({ provider = BnaExchangeRateProvider } = {}) {
    this.provider = provider
  }

  async getUsdArsSellingQuote(options = {}) {
    const startedAt = Date.now()

    try {
      const quote = normalizeQuote(await this.provider.getUsdArsSellingQuote(options))

      secureLog('✅ ExchangeRateService cotización BNA obtenida', {
        source: quote.source,
        quoteType: quote.quoteType,
        rate: quote.rate,
        sourceDate: quote.sourceDate,
        fetchedAt: quote.fetchedAt,
        durationMs: Date.now() - startedAt
      })

      return quote
    } catch (error) {
      let mappedError

      if (error instanceof ServiceError) {
        mappedError = error
      } else if (error instanceof BnaExchangeRateProviderError) {
        mappedError = new ServiceError(error.message, error.code, error.status)
      } else {
        mappedError = new ServiceError(
          'No se pudo obtener la cotización oficial de BNA',
          'BNA_QUOTE_UNAVAILABLE',
          503
        )
      }

      logError('❌ ExchangeRateService getUsdArsSellingQuote error:', {
        code: mappedError.code,
        durationMs: Date.now() - startedAt
      })
      throw mappedError
    }
  }

  async getOrderTotalsInArs(totalUsd, options = {}) {
    try {
      const quote = await this.getUsdArsSellingQuote(options)
      return this.calculateOrderTotalsFromQuote(totalUsd, quote)
    } catch (error) {
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo calcular el total de la orden en ARS',
        'EXCHANGE_RATE_CALCULATION_ERROR',
        500
      )
    }
  }

  calculateOrderTotalsFromQuote(totalUsd, quote) {
    try {
      const normalizedQuote = normalizeQuote(quote)
      const conversion = convertUsdToArs({ totalUsd, rate: normalizedQuote.rate })

      return {
        totalUsd: conversion.totalUsd,
        exchangeRateSnapshot: { ...normalizedQuote },
        totalArs: conversion.totalArs
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo calcular el total de la orden en ARS',
        'EXCHANGE_RATE_CALCULATION_ERROR',
        500
      )
    }
  }
}

export { ExchangeRateService, EXPECTED_QUOTE, normalizeQuote }
export default new ExchangeRateService()
