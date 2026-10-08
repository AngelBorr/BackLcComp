/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { CheckoutService, RESERVATION_DURATION_MS } from '../../src/services/checkout.service.js'
import { OrderService } from '../../src/services/order.service.js'
import ProductUnitService from '../../src/services/productUnit.service.js'
import { ServiceError } from '../../src/services/service.products.js'

const userId = new mongoose.Types.ObjectId().toString()
const otherUserId = new mongoose.Types.ObjectId().toString()
const productA = '000000000000000000000001'
const productB = '000000000000000000000002'
const fixedNow = new Date('2026-09-29T12:00:00.000Z')
const expectedExpiration = new Date(fixedNow.getTime() + RESERVATION_DURATION_MS).toISOString()
const quote = Object.freeze({
  source: 'BNA',
  quoteType: 'billete_venta',
  baseCurrency: 'USD',
  quoteCurrency: 'ARS',
  rate: '2.0000',
  sourceDate: '2026-09-29',
  sourceUpdatedTime: '09:00',
  sourceEffectiveAt: '2026-09-29T12:00:00.000Z',
  fetchedAt: '2026-09-29T12:01:00.000Z',
  sourceUrl: 'https://www.bna.com.ar/Personas'
})

const cloneMap = (map) => new Map(map)
const asCents = (value) => Math.round(Number(value) * 100)
const asDecimal = (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

const makeUser = (id, role = 'USER', emailVerified = true) => ({
  _id: id,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  role,
  emailVerified
})

const makeHarness = (overrides = {}) => {
  const state = {
    events: [],
    orders: new Map(),
    items: new Map(),
    payments: new Map(),
    reservations: [],
    pricingCalls: [],
    userCalls: [],
    orderCalls: [],
    paymentCalls: [],
    bnaCalls: 0,
    conversionCalls: 0,
    sessionStarts: 0,
    sessionEnds: 0,
    transactionOptions: null,
    financialGuardCalls: [],
    committed: 0,
    aborted: 0
  }
  const config = {
    preflightUser: makeUser(userId),
    transactionUser: makeUser(userId),
    preflightPrices: { [productA]: '10.00', [productB]: '20.00' },
    transactionPrices: { [productA]: '10.00', [productB]: '20.00' },
    ...overrides
  }
  const session = {
    hasEnded: false,
    inTransaction: () => true,
    async withTransaction(operation, options) {
      state.events.push('transaction:start')
      state.transactionOptions = options
      const snapshot = {
        orders: cloneMap(state.orders),
        items: cloneMap(state.items),
        payments: cloneMap(state.payments),
        reservations: [...state.reservations]
      }

      try {
        await operation()
        state.committed += 1
        state.events.push('transaction:commit')
      } catch (error) {
        state.orders = snapshot.orders
        state.items = snapshot.items
        state.payments = snapshot.payments
        state.reservations = snapshot.reservations
        state.aborted += 1
        state.events.push('transaction:abort')
        throw error
      }
    },
    async endSession() {
      state.sessionEnds += 1
      session.hasEnded = true
    }
  }
  const mongooseInstance = {
    async startSession() {
      state.sessionStarts += 1
      state.events.push('session:start')
      session.hasEnded = false
      return session
    }
  }
  const orderManager = {
    async getByUserAndCheckoutIdempotencyKey(requestedUserId, key, { session: usedSession } = {}) {
      state.events.push(usedSession ? 'idempotency:transaction' : 'idempotency:precheck')
      return state.orders.get(`${requestedUserId}:${key}`) || null
    }
  }
  const orderItemManager = {
    async getByOrderId(orderId, { session: usedSession } = {}) {
      state.events.push(usedSession ? 'items:transaction' : 'items:existing')
      return state.items.get(String(orderId)) || []
    }
  }
  const paymentManager = {
    async getLatestByOrderId(orderId, { session: usedSession } = {}) {
      state.events.push(usedSession ? 'payment:transaction' : 'payment:existing')
      return state.payments.get(String(orderId)) || null
    }
  }
  const commercePricingService = {
    async getAuthoritativeUserContext(requestedUserId, { session: usedSession } = {}) {
      const source = usedSession ? config.transactionUser : config.preflightUser
      const user = { ...source, _id: requestedUserId }
      state.userCalls.push({ session: usedSession, role: user.role, emailVerified: user.emailVerified })
      state.events.push(usedSession ? 'user:transaction' : 'user:precheck')
      return { user, userId: requestedUserId, role: user.role }
    },
    async getOrderItemSnapshot(request, { session: usedSession } = {}) {
      state.pricingCalls.push({ ...request, session: usedSession })
      state.events.push(usedSession ? 'pricing:transaction' : 'pricing:preflight')

      if (!usedSession && config.preflightError) throw config.preflightError

      const activeUser = usedSession ? config.transactionUser : config.preflightUser
      const prices = usedSession ? config.transactionPrices : config.preflightPrices
      const unitPriceUsd = prices[request.productId] || '10.00'

      return {
        user: { ...activeUser, _id: request.userId },
        item: {
          productId: request.productId,
          productSnapshot: { name: `Product ${request.productId.slice(-1)}`, brand: 'LC', category: 'IT' },
          quantity: request.quantity,
          priceType: String(activeUser.role).toUpperCase() === 'PREMIUM' ? 'wholesale' : 'retail',
          unitPriceUsd,
          vatRate: 0.21,
          currency: 'USD'
        }
      }
    }
  }
  const exchangeRateService = {
    async getUsdArsSellingQuote() {
      state.bnaCalls += 1
      state.events.push('bna')
      if (config.bnaError) throw config.bnaError
      return { ...quote }
    },
    calculateOrderTotalsFromQuote(totalUsd, suppliedQuote) {
      state.conversionCalls += 1
      state.events.push('conversion')
      return {
        totalUsd,
        totalArs: (Number(totalUsd) * Number(suppliedQuote.rate)).toFixed(2),
        exchangeRateSnapshot: { ...suppliedQuote }
      }
    }
  }
  const orderService = {
    async createBaseOrder(input, options) {
      state.orderCalls.push({ input, options })
      state.events.push('order:create')
      const authoritativeItems = []
      let totalCents = 0

      for (const requestedItem of input.items) {
        const { item } = await commercePricingService.getOrderItemSnapshot(
          { userId: input.userId, ...requestedItem },
          { session: options.session }
        )
        const lineCents = asCents(item.unitPriceUsd) * item.quantity
        totalCents += lineCents
        authoritativeItems.push({
          _id: new mongoose.Types.ObjectId(),
          ...item,
          unitPriceUsd: asDecimal(asCents(item.unitPriceUsd)),
          totalUsd: asDecimal(lineCents)
        })
      }

      const totals = exchangeRateService.calculateOrderTotalsFromQuote(
        asDecimal(totalCents),
        input.exchangeRateQuote
      )
      const order = {
        _id: new mongoose.Types.ObjectId(),
        orderNumber: `LC-2026-${String(state.orderCalls.length).padStart(6, '0')}`,
        userId: input.userId,
        status: 'pending_payment',
        reservationExpiresAt: input.reservationExpiresAt,
        checkoutIdempotencyKey: input.checkoutIdempotencyKey,
        checkoutRequestHash: input.checkoutRequestHash,
        totals: { totalUsd: totals.totalUsd, totalArs: totals.totalArs },
        exchangeRateSnapshot: totals.exchangeRateSnapshot
      }
      const items = authoritativeItems.map((item) => ({ ...item, orderId: order._id }))

      state.orders.set(`${input.userId}:${input.checkoutIdempotencyKey}`, order)
      state.items.set(String(order._id), items)
      return { order, items }
    }
  }
  const productUnitService = {
    async reserveAvailableUnits(input, options) {
      state.events.push(`reserve:${input.productId}`)
      state.reservations.push({ input, session: options.session })
      if (config.reservationFailureProductId === input.productId) {
        throw new ServiceError('Stock insuficiente', 'INSUFFICIENT_SERIALIZED_STOCK', 409)
      }
      return { reservedCount: input.quantity, reservationExpiresAt: input.reservationExpiresAt }
    }
  }
  const paymentService = {
    async createPayment(input, options) {
      state.paymentCalls.push({ input, options })
      state.events.push('payment:create')
      const order = [...state.orders.values()].find(
        (candidate) => String(candidate._id) === String(input.orderId)
      )
      const payment = {
        _id: new mongoose.Types.ObjectId(),
        orderId: input.orderId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        amountArs: order.totals.totalArs,
        preferenceId: null,
        providerPaymentId: null
      }
      state.payments.set(String(input.orderId), payment)
      return payment
    }
  }
  const checkoutFinancialGuardService = {
    async assertCanCreateCheckout(requestedUserId, options) {
      state.financialGuardCalls.push({ userId: requestedUserId, options })
      if (config.financialError) throw config.financialError
      return { allowed: true, blocker: null }
    },
    async assertCanContinueCheckout(requestedUserId, checkoutId, options) {
      state.financialGuardCalls.push({
        userId: requestedUserId,
        checkoutId,
        options,
        continuation: true
      })
      if (config.financialError) throw config.financialError
      return { allowed: true, blocker: null }
    }
  }
  const service = new CheckoutService({
    mongooseInstance,
    orderManager,
    orderItemManager,
    paymentManager,
    commercePricingService,
    exchangeRateService,
    orderService,
    productUnitService,
    paymentService,
    checkoutFinancialGuardService
  })

  return { service, state, session, config }
}

const request = (overrides = {}) => ({
  userId,
  idempotencyKey: 'checkout-test-001',
  items: [{ productId: productA, quantity: 1 }],
  ...overrides
})

describe('CheckoutService transactional orchestration (isolated unit tests)', () => {
  it('allows a verified USER to complete checkout', async () => {
    const { service, state } = makeHarness()
    const result = await service.createCheckout(request(), { now: fixedNow })

    assert.equal(result.order.status, 'pending_payment')
    assert.equal(state.committed, 1)
  })

  it('rejects an unverified USER before BNA and before a session', async () => {
    const { service, state } = makeHarness({ preflightUser: makeUser(userId, 'USER', false) })

    await assert.rejects(service.createCheckout(request()), (error) => error.code === 'CHECKOUT_EMAIL_NOT_VERIFIED')
    assert.equal(state.bnaCalls, 0)
    assert.equal(state.sessionStarts, 0)
  })

  it('allows PREMIUM without public email verification', async () => {
    const premium = makeUser(userId, 'PREMIUM', false)
    const { service } = makeHarness({ preflightUser: premium, transactionUser: premium })
    const result = await service.createCheckout(request(), { now: fixedNow })

    assert.equal(result.items[0].priceType, 'wholesale')
  })

  it('rejects ADMIN before BNA', async () => {
    const admin = makeUser(userId, 'ADMIN', true)
    const { service, state } = makeHarness({ preflightUser: admin, transactionUser: admin })

    await assert.rejects(service.createCheckout(request()), (error) => error.code === 'CHECKOUT_FORBIDDEN_ROLE')
    assert.equal(state.bnaCalls, 0)
  })

  it('rejects an empty cart', async () => {
    const { service, state } = makeHarness()
    await assert.rejects(service.createCheckout(request({ items: [] })), (error) => error.code === 'CHECKOUT_EMPTY')
    assert.equal(state.bnaCalls, 0)
  })

  it('rejects an invalid quantity', async () => {
    const { service } = makeHarness()
    await assert.rejects(
      service.createCheckout(request({ items: [{ productId: productA, quantity: 1.5 }] })),
      (error) => error.code === 'CHECKOUT_INVALID_ITEM'
    )
  })

  it('rejects grouped quantity overflow', async () => {
    const { service } = makeHarness()
    await assert.rejects(
      service.createCheckout(request({
        items: [
          { productId: productA, quantity: Number.MAX_SAFE_INTEGER },
          { productId: productA, quantity: 1 }
        ]
      })),
      (error) => error.code === 'CHECKOUT_INVALID_ITEM'
    )
  })

  it('groups duplicate products before pricing, creation and reservation', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request({
      items: [
        { productId: productA, quantity: 2 },
        { productId: productA, quantity: 3 }
      ]
    }), { now: fixedNow })

    assert.deepEqual(state.orderCalls[0].input.items, [{ productId: productA, quantity: 5 }])
    assert.equal(state.reservations.length, 1)
    assert.equal(state.reservations[0].input.quantity, 5)
  })

  it('does not call BNA when authoritative preflight fails', async () => {
    const { service, state } = makeHarness({
      preflightError: new ServiceError('Producto inactivo', 'PRODUCT_INACTIVE', 409)
    })
    await assert.rejects(service.createCheckout(request()), (error) => error.code === 'PRODUCT_INACTIVE')
    assert.equal(state.bnaCalls, 0)
    assert.equal(state.sessionStarts, 0)
  })

  it('blocks a new idempotency key before pricing, reservations or Payment creation', async () => {
    const financialError = new ServiceError(
      'Tu pago ya fue acreditado',
      'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
      409
    )
    const { service, state } = makeHarness({ financialError })

    await assert.rejects(
      service.createCheckout(request({
        idempotencyKey: 'entirely-new-key',
        items: [{ productId: productA, quantity: 2 }]
      }), { now: fixedNow }),
      (error) => error.code === 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT'
    )

    assert.equal(state.bnaCalls, 0)
    assert.equal(state.orderCalls.length, 0)
    assert.equal(state.paymentCalls.length, 0)
    assert.equal(state.reservations.length, 0)
  })

  it('creates no new commerce records when reconciliation confirms a prior payment', async () => {
    const financialError = new ServiceError(
      'Tu pago anterior fue confirmado. No es necesario volver a pagar.',
      'CHECKOUT_PRIOR_PAYMENT_CONFIRMED',
      409
    )
    const { service, state } = makeHarness({ financialError })

    await assert.rejects(
      service.createCheckout(request({ idempotencyKey: 'new-key-after-paid' }), {
        now: fixedNow
      }),
      (error) => error.code === 'CHECKOUT_PRIOR_PAYMENT_CONFIRMED'
    )

    assert.equal(state.bnaCalls, 0)
    assert.equal(state.sessionStarts, 0)
    assert.equal(state.orderCalls.length, 0)
    assert.equal(state.paymentCalls.length, 0)
    assert.equal(state.reservations.length, 0)
  })

  it('does not open a transaction or write when BNA fails', async () => {
    const { service, state } = makeHarness({
      bnaError: new ServiceError('BNA no disponible', 'BNA_QUOTE_UNAVAILABLE', 503)
    })
    await assert.rejects(service.createCheckout(request()), (error) => error.code === 'BNA_QUOTE_UNAVAILABLE')
    assert.equal(state.sessionStarts, 0)
    assert.equal(state.orders.size, 0)
    assert.equal(state.reservations.length, 0)
  })

  it('obtains BNA before starting the Mongo session', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.ok(state.events.indexOf('bna') < state.events.indexOf('session:start'))
  })

  it('does not open the transaction when the lease fence is lost after BNA', async () => {
    const { service, state } = makeHarness()
    let assertions = 0

    await assert.rejects(
      service.createCheckout(request(), {
        now: fixedNow,
        async assertCheckoutLeaseOwnership() {
          assertions += 1
          if (assertions === 2) {
            throw new ServiceError('Lease perdido', 'CHECKOUT_LOCK_LOST', 409)
          }
        }
      }),
      (error) => error.code === 'CHECKOUT_LOCK_LOST'
    )

    assert.equal(state.bnaCalls, 1)
    assert.equal(state.sessionStarts, 0)
    assert.equal(state.orderCalls.length, 0)
    assert.equal(state.reservations.length, 0)
    assert.equal(state.paymentCalls.length, 0)
  })

  it('rolls back local writes when the lease fence is lost inside the transaction', async () => {
    const { service, state } = makeHarness()
    let assertions = 0

    await assert.rejects(
      service.createCheckout(request(), {
        now: fixedNow,
        async assertCheckoutLeaseOwnership() {
          assertions += 1
          if (assertions === 3) {
            throw new ServiceError('Lease perdido', 'CHECKOUT_LOCK_LOST', 409)
          }
        }
      }),
      (error) => error.code === 'CHECKOUT_LOCK_LOST'
    )

    assert.equal(state.aborted, 1)
    assert.equal(state.orders.size, 0)
    assert.equal(state.reservations.length, 0)
    assert.equal(state.payments.size, 0)
  })

  it('revalidates the user inside the transaction', async () => {
    const { service, state, session } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.ok(state.userCalls.some((call) => call.session === session))
  })

  it('recalculates item pricing inside the transaction', async () => {
    const { service, state, session } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.ok(state.pricingCalls.some((call) => call.session === session))
  })

  it('uses the transactional price when it changed after preflight', async () => {
    const { service } = makeHarness({
      preflightPrices: { [productA]: '10.00' },
      transactionPrices: { [productA]: '12.50' }
    })
    const result = await service.createCheckout(request(), { now: fixedNow })
    assert.equal(result.items[0].unitPriceUsd, '12.50')
    assert.equal(result.totals.totalUsd, '12.50')
  })

  it('applies the transactional role when it changed after preflight', async () => {
    const { service } = makeHarness({
      preflightUser: makeUser(userId, 'USER', true),
      transactionUser: makeUser(userId, 'PREMIUM', false)
    })
    const result = await service.createCheckout(request(), { now: fixedNow })
    assert.equal(result.items[0].priceType, 'wholesale')
  })

  it('applies transactional email verification and rolls back', async () => {
    const { service, state } = makeHarness({
      transactionUser: makeUser(userId, 'USER', false)
    })
    await assert.rejects(
      service.createCheckout(request(), { now: fixedNow }),
      (error) => error.code === 'CHECKOUT_EMAIL_NOT_VERIFIED'
    )
    assert.equal(state.aborted, 1)
    assert.equal(state.orders.size, 0)
  })

  it('uses the same session for Order and its authoritative pricing', async () => {
    const { service, state, session } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.equal(state.orderCalls[0].options.session, session)
    assert.ok(state.pricingCalls.filter((call) => call.session).every((call) => call.session === session))
  })

  it('uses the same session for every reservation', async () => {
    const { service, state, session } = makeHarness()
    await service.createCheckout(request({
      items: [
        { productId: productA, quantity: 1 },
        { productId: productB, quantity: 1 }
      ]
    }), { now: fixedNow })
    assert.ok(state.reservations.every((reservation) => reservation.session === session))
  })

  it('shares exactly one reservation expiration across Order and all units', async () => {
    const { service, state } = makeHarness()
    const result = await service.createCheckout(request({
      items: [
        { productId: productA, quantity: 1 },
        { productId: productB, quantity: 1 }
      ]
    }), { now: fixedNow })
    const expirations = state.reservations.map((reservation) => reservation.input.reservationExpiresAt.toISOString())
    assert.deepEqual(expirations, [expectedExpiration, expectedExpiration])
    assert.equal(result.order.reservationExpiresAt, expectedExpiration)
  })

  it('rolls back Order, first reservation and Payment when a later line lacks stock', async () => {
    const { service, state } = makeHarness({ reservationFailureProductId: productB })
    await assert.rejects(
      service.createCheckout(request({
        items: [
          { productId: productA, quantity: 1 },
          { productId: productB, quantity: 1 }
        ]
      }), { now: fixedNow }),
      (error) => error.code === 'INSUFFICIENT_SERIALIZED_STOCK'
    )
    assert.equal(state.aborted, 1)
    assert.equal(state.orders.size, 0)
    assert.equal(state.items.size, 0)
    assert.equal(state.reservations.length, 0)
    assert.equal(state.payments.size, 0)
  })

  it('sums two authoritative line totals exactly into Order totalUsd', async () => {
    const { service } = makeHarness()
    const result = await service.createCheckout(request({
      items: [
        { productId: productA, quantity: 2 },
        { productId: productB, quantity: 3 }
      ]
    }), { now: fixedNow })
    assert.equal(result.totals.totalUsd, '80.00')
    assert.equal(result.items.reduce((sum, item) => sum + Number(item.totalUsd), 0), 80)
  })

  it('converts only the final transactional USD total to ARS once', async () => {
    const { service, state } = makeHarness()
    const result = await service.createCheckout(request({
      items: [
        { productId: productA, quantity: 2 },
        { productId: productB, quantity: 3 }
      ]
    }), { now: fixedNow })
    assert.equal(state.conversionCalls, 1)
    assert.equal(result.totals.totalArs, '160.00')
  })

  it('preserves the BNA quote as the Order exchange snapshot', async () => {
    const { service } = makeHarness()
    const result = await service.createCheckout(request(), { now: fixedNow })
    assert.deepEqual(result.exchangeRate, {
      source: 'BNA',
      quoteType: 'billete_venta',
      rate: '2.0000',
      sourceDate: '2026-09-29',
      fetchedAt: '2026-09-29T12:01:00.000Z'
    })
  })

  it('creates Payment without accepting amountArs from Checkout', async () => {
    const { service, state } = makeHarness()
    const result = await service.createCheckout(request(), { now: fixedNow })
    assert.deepEqual(Object.keys(state.paymentCalls[0].input), ['orderId'])
    assert.equal(String(state.paymentCalls[0].input.orderId), result.order.id)
    assert.equal([...state.payments.values()][0].amountArs, result.totals.totalArs)
  })

  it('keeps Payment pending without preferenceId or providerPaymentId', async () => {
    const { service, state } = makeHarness()
    const result = await service.createCheckout(request(), { now: fixedNow })
    const storedPayment = [...state.payments.values()][0]
    assert.deepEqual(result.payment, {
      id: String(storedPayment._id),
      status: 'pending',
      provider: 'mercado_pago'
    })
    assert.equal(storedPayment.preferenceId, null)
    assert.equal(storedPayment.providerPaymentId, null)
  })

  it('returns an existing checkout for the same user and idempotency key', async () => {
    const { service, state } = makeHarness()
    const first = await service.createCheckout(request(), { now: fixedNow })
    const second = await service.createCheckout(request(), { now: fixedNow })
    assert.equal(first.isIdempotent, false)
    assert.equal(second.isIdempotent, true)
    assert.deepEqual({ ...second, isIdempotent: false }, first)
    assert.equal(state.orderCalls.length, 1)
  })

  it('does not reserve again on an idempotent retry', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    await service.createCheckout(request(), { now: fixedNow })
    assert.equal(state.reservations.length, 1)
  })

  it('does not create another Payment on an idempotent retry', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    await service.createCheckout(request(), { now: fixedNow })
    assert.equal(state.paymentCalls.length, 1)
  })

  it('does not expose another user checkout that used the same key', async () => {
    const { service, state } = makeHarness()
    const first = await service.createCheckout(request(), { now: fixedNow })
    const second = await service.createCheckout(request({ userId: otherUserId }), { now: fixedNow })
    assert.notEqual(second.order.id, first.order.id)
    assert.equal(state.orderCalls.length, 2)
  })

  it('rejects the same user and key with an incompatible normalized cart', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    await assert.rejects(
      service.createCheckout(request({ items: [{ productId: productA, quantity: 2 }] })),
      (error) => error.code === 'CHECKOUT_IDEMPOTENCY_CONFLICT'
    )
    assert.equal(state.orderCalls.length, 1)
  })

  it('rejects caller-controlled monetary fields', async () => {
    const { service, state } = makeHarness()
    await assert.rejects(
      service.createCheckout({ ...request(), totalArs: '0.01' }),
      (error) => error.code === 'CHECKOUT_INVALID_INPUT'
    )
    await assert.rejects(
      service.createCheckout(request({ items: [{ productId: productA, quantity: 1, price: 0.01 }] })),
      (error) => error.code === 'CHECKOUT_INVALID_ITEM'
    )
    assert.equal(state.bnaCalls, 0)
  })

  it('uses snapshot read concern and majority write concern', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.deepEqual(state.transactionOptions, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    })
  })

  it('always closes its owned Mongo session', async () => {
    const { service, state } = makeHarness()
    await service.createCheckout(request(), { now: fixedNow })
    assert.equal(state.sessionEnds, 1)
  })

  it('keeps reserved to sold unavailable without an approved Mercado Pago payment', async () => {
    await assert.rejects(
      ProductUnitService.confirmReservedUnitsSold({ orderId: new mongoose.Types.ObjectId(), paymentId: 'payment' }),
      (error) => error.code === 'APPROVED_PAYMENT_REQUIRED'
    )
  })

  it('lets OrderService derive ARS totals from the supplied trusted quote inside the session', async () => {
    const captured = {}
    const externalSession = { hasEnded: false, inTransaction: () => true }
    const pricing = {
      async getOrderItemSnapshot(request, options) {
        captured.pricingSession = options.session
        return {
          user: makeUser(request.userId),
          item: {
            productId: request.productId,
            productSnapshot: { name: 'Notebook', brand: 'LC', category: 'IT' },
            quantity: request.quantity,
            priceType: 'retail',
            unitPriceUsd: '10.00',
            vatRate: 0.21,
            currency: 'USD'
          }
        }
      }
    }
    const service = new OrderService({
      commercePricingService: pricing,
      exchangeRateService: {
        calculateOrderTotalsFromQuote(totalUsd, suppliedQuote) {
          captured.conversion = { totalUsd, suppliedQuote }
          return { totalUsd, totalArs: '20.00', exchangeRateSnapshot: suppliedQuote }
        }
      },
      orderNumberManager: { async nextOrderNumber() { return 'LC-2026-000001' } },
      orderManager: {
        async create(data) {
          captured.order = data
          return { _id: new mongoose.Types.ObjectId(), ...data }
        }
      },
      orderItemManager: {
        async createMany(data) {
          return data.map((item) => ({ _id: new mongoose.Types.ObjectId(), ...item }))
        }
      }
    })

    await service.createBaseOrder(
      {
        userId,
        items: [{ productId: productA, quantity: 1 }],
        exchangeRateQuote: quote,
        checkoutIdempotencyKey: 'trusted-key',
        checkoutRequestHash: 'a'.repeat(64)
      },
      { session: externalSession, now: fixedNow }
    )

    assert.equal(captured.pricingSession, externalSession)
    assert.equal(captured.conversion.totalUsd, '10.00')
    assert.equal(captured.order.totals.totalArs, '20.00')
    assert.deepEqual(captured.order.exchangeRateSnapshot, quote)
  })
})
