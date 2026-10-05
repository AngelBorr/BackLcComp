import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { CommerceController, publicExchangeRateDto } from '../../src/controllers/commerce.controller.js'
import { registerCommerceRoutes } from '../../src/routes/commerce.router.js'

const quote = {
  source: 'BNA',
  quoteType: 'billete_venta',
  baseCurrency: 'USD',
  quoteCurrency: 'ARS',
  rate: '1540.0000',
  sourceDate: '2026-10-02',
  sourceUpdatedTime: '17:00',
  sourceEffectiveAt: '2026-10-02T20:00:00.000Z',
  fetchedAt: '2026-10-02T20:01:00.000Z',
  sourceUrl: 'https://www.bna.com.ar/Personas'
}

const createApp = (exchangeRateService) => {
  const app = express()
  const controller = new CommerceController({ exchangeRateService })
  app.get('/api/commerce/exchange-rate', controller.getExchangeRate)
  return app
}

describe('GET /api/commerce/exchange-rate (isolated unit tests)', () => {
  it('registers a public read-only route', () => {
    let registered
    registerCommerceRoutes({
      get(path, policies, handler) {
        registered = { path, policies, handler }
      }
    }, { getExchangeRate() {} })

    assert.equal(registered.path, '/exchange-rate')
    assert.deepEqual(registered.policies, ['PUBLIC'])
    assert.equal(typeof registered.handler, 'function')
  })

  it('returns only the safe public quote DTO', async () => {
    const response = await request(createApp({
      async getUsdArsSellingQuote() {
        return quote
      }
    })).get('/api/commerce/exchange-rate')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, publicExchangeRateDto(quote))
    assert.equal('sourceUrl' in response.body, false)
    assert.equal('fetchedAt' in response.body, false)
    assert.equal('sourceEffectiveAt' in response.body, false)
  })

  it('returns a controlled unavailable response without technical details', async () => {
    const response = await request(createApp({
      async getUsdArsSellingQuote() {
        const error = new Error('TLS certificate failure at internal source URL')
        error.stack = 'sensitive stack'
        throw error
      }
    })).get('/api/commerce/exchange-rate')

    assert.equal(response.status, 503)
    assert.deepEqual(response.body, {
      status: 'unavailable',
      message: 'Cotización temporalmente no disponible'
    })
  })
})
