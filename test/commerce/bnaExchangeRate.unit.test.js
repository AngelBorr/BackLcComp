/* eslint-env mocha */
import assert from 'node:assert/strict'
import {
  BnaExchangeRateProvider,
  parseBnaBilleteSellingQuote
} from '../../src/providers/bnaExchangeRate.provider.js'
import { ExchangeRateService } from '../../src/services/exchangeRate.service.js'
import {
  calculateUsdLineAmounts,
  convertUsdToArs,
  minorUnitsToDecimalString
} from '../../src/utils/commerceMoney.js'

const fetchedAt = new Date('2026-09-28T20:15:00.000Z')

const quoteTable = ({
  id = 'billetes',
  date = '28/9/2026',
  headers = ['Compra', 'Venta'],
  rows = [['Dolar U.S.A', '1495,00', '1545,1250']],
  updatedTime = '17:01'
} = {}) => `
  <div class="tab-pane" id="${id}">
    <table class="table cotizacion">
      <thead><tr><th class="fechaCot">${date}</th>${headers.map((value) => `<th>${value}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((cells) => `<tr>${cells.map((cell, index) => `<td${index === 0 ? ' class="tit"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
    <div class="legal">Hora Actualización: ${updatedTime}</div>
  </div>`

const fixture = (billetes = quoteTable()) => `
  <html><body>
    ${quoteTable({
      id: 'divisas',
      rows: [['Dolar U.S.A', '1515.5000', '1524.5000']]
    })}
    ${billetes}
  </body></html>`

const htmlResponse = (html, overrides = {}) => ({
  ok: true,
  status: 200,
  url: 'https://www.bna.com.ar/Personas',
  headers: {
    get(name) {
      if (name.toLowerCase() === 'content-type') return 'text/html; charset=utf-8'
      if (name.toLowerCase() === 'content-length') return String(Buffer.byteLength(html))
      return null
    }
  },
  async text() {
    return html
  },
  ...overrides
})

describe('BNA authoritative exchange rate (isolated unit tests)', () => {
  it('parses only Cotización Billetes, Dolar U.S.A and Venta', () => {
    const quote = parseBnaBilleteSellingQuote(fixture(), { fetchedAt })

    assert.deepEqual(quote, {
      source: 'BNA',
      quoteType: 'billete_venta',
      baseCurrency: 'USD',
      quoteCurrency: 'ARS',
      rate: '1545.1250',
      sourceDate: '2026-09-28',
      sourceUpdatedTime: '17:01',
      sourceEffectiveAt: '2026-09-28T20:01:00.000Z',
      fetchedAt: fetchedAt.toISOString(),
      sourceUrl: 'https://www.bna.com.ar/Personas'
    })
    assert.notEqual(quote.rate, '1524.5000')
  })

  it('normalizes the Argentine comma decimal format', () => {
    const html = fixture(quoteTable({ rows: [['Dolar U.S.A', '1.495,00', '1.545,00']] }))
    const quote = parseBnaBilleteSellingQuote(html, { fetchedAt })

    assert.equal(quote.rate, '1545.00')
  })

  it('accepts the latest BNA publication even when sourceDate is earlier than fetchedAt', () => {
    const oldPublication = quoteTable({ date: '25/9/2026' })
    const quote = parseBnaBilleteSellingQuote(fixture(oldPublication), { fetchedAt })

    assert.equal(quote.sourceDate, '2026-09-25')
    assert.equal(quote.fetchedAt, fetchedAt.toISOString())
  })

  it('fails if Dolar U.S.A is absent', () => {
    const html = fixture(quoteTable({ rows: [['Euro', '1685,00', '1785,00']] }))

    assert.throws(
      () => parseBnaBilleteSellingQuote(html, { fetchedAt }),
      (error) => error.code === 'BNA_QUOTE_PARSE_ERROR'
    )
  })

  it('fails if Venta is absent', () => {
    const html = fixture(
      quoteTable({ headers: ['Compra'], rows: [['Dolar U.S.A', '1495,00']] })
    )

    assert.throws(
      () => parseBnaBilleteSellingQuote(html, { fetchedAt }),
      (error) => error.code === 'BNA_QUOTE_PARSE_ERROR'
    )
  })

  it('fails when the Billetes structure is ambiguous', () => {
    const duplicatedRows = [
      ['Dolar U.S.A', '1495,00', '1545,00'],
      ['Dolar U.S.A', '1496,00', '1546,00']
    ]

    assert.throws(
      () => parseBnaBilleteSellingQuote(fixture(quoteTable({ rows: duplicatedRows })), { fetchedAt }),
      (error) => error.code === 'BNA_QUOTE_PARSE_ERROR'
    )
  })

  it('rejects a non-positive selling rate', () => {
    const html = fixture(quoteTable({ rows: [['Dolar U.S.A', '1495,00', '0,00']] }))

    assert.throws(
      () => parseBnaBilleteSellingQuote(html, { fetchedAt }),
      (error) => error.code === 'BNA_QUOTE_INVALID'
    )
  })

  it('normalizes HTTP and source metadata', async () => {
    const provider = new BnaExchangeRateProvider({
      fetchImplementation: async () => htmlResponse(fixture())
    })

    const quote = await provider.getUsdArsSellingQuote({ now: fetchedAt })

    assert.equal(quote.source, 'BNA')
    assert.equal(quote.quoteType, 'billete_venta')
    assert.equal(quote.sourceDate, '2026-09-28')
    assert.equal(quote.fetchedAt, fetchedAt.toISOString())
  })

  it('fails closed on an HTTP response outside 2xx', async () => {
    const provider = new BnaExchangeRateProvider({
      fetchImplementation: async () => htmlResponse('', { ok: false, status: 503 })
    })

    await assert.rejects(
      provider.getUsdArsSellingQuote(),
      (error) => error.code === 'BNA_QUOTE_UNAVAILABLE'
    )
  })

  it('aborts the BNA request after the configured timeout', async () => {
    const provider = new BnaExchangeRateProvider({
      timeoutMs: 5,
      fetchImplementation: async (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    })

    await assert.rejects(
      provider.getUsdArsSellingQuote(),
      (error) => error.code === 'BNA_QUOTE_TIMEOUT'
    )
  })

  it('converts USD to ARS exactly without binary floating-point authority', () => {
    assert.deepEqual(convertUsdToArs({ totalUsd: '100.00', rate: '1545.00' }), {
      totalUsd: '100.00',
      rate: '1545.00',
      totalArs: '154500.00'
    })
    assert.equal(
      convertUsdToArs({ totalUsd: '10.01', rate: '1545.1250' }).totalArs,
      '15466.70'
    )
  })

  it('uses round-half-up only on the final ARS result', () => {
    assert.equal(convertUsdToArs({ totalUsd: '0.01', rate: '1.5' }).totalArs, '0.02')
    assert.equal(convertUsdToArs({ totalUsd: '0.01', rate: '1.4' }).totalArs, '0.01')
  })

  it('converts the summed USD order total once and preserves rate precision', async () => {
    const first = calculateUsdLineAmounts({ unitPriceUsd: '10.00', vatRate: 0.21, quantity: 3 })
    const second = calculateUsdLineAmounts({ unitPriceUsd: '110.50', vatRate: 0.105, quantity: 2 })
    const totalUsd = minorUnitsToDecimalString(first.totalUsdCents + second.totalUsdCents)
    let providerCalls = 0
    const service = new ExchangeRateService({
      provider: {
        async getUsdArsSellingQuote() {
          providerCalls += 1
          return parseBnaBilleteSellingQuote(fixture(), { fetchedAt })
        }
      }
    })

    const result = await service.getOrderTotalsInArs(totalUsd)

    assert.equal(totalUsd, '251.00')
    assert.equal(providerCalls, 1)
    assert.equal(result.totalArs, '387826.38')
    assert.equal(result.exchangeRateSnapshot.rate, '1545.1250')
  })

  it('converts a final Order total from an already-fetched quote without another provider call', () => {
    let providerCalls = 0
    const service = new ExchangeRateService({
      provider: {
        async getUsdArsSellingQuote() {
          providerCalls += 1
        }
      }
    })
    const existingQuote = parseBnaBilleteSellingQuote(fixture(), { fetchedAt })
    const result = service.calculateOrderTotalsFromQuote('10.01', existingQuote)

    assert.equal(providerCalls, 0)
    assert.equal(result.totalArs, '15466.70')
    assert.deepEqual(result.exchangeRateSnapshot, existingQuote)
  })

  it('discriminates 21% IVA on the gross line for quantity greater than one', () => {
    const amounts = calculateUsdLineAmounts({ unitPriceUsd: '10.00', vatRate: 0.21, quantity: 3 })

    assert.equal(amounts.totalUsd, '30.00')
    assert.equal(amounts.lineNetUsd, '24.79')
    assert.equal(amounts.lineVatUsd, '5.21')
  })

  it('discriminates 10.5% IVA on the gross line for quantity greater than one', () => {
    const amounts = calculateUsdLineAmounts({ unitPriceUsd: '110.50', vatRate: 0.105, quantity: 3 })

    assert.equal(amounts.totalUsd, '331.50')
    assert.equal(amounts.lineNetUsd, '300.00')
    assert.equal(amounts.lineVatUsd, '31.50')
  })
})
