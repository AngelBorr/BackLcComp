/* eslint-env mocha */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import env from '../../src/config.js'
import { OrderAttentionController } from '../../src/controllers/orderAttention.controller.js'
import { serviceErrorHandler } from '../../src/middlewares/serviceErrorHandler.js'
import { ServiceError } from '../../src/services/service.products.js'
import {
  normalizeInventoryRepairCommandInput
} from '../../src/services/orderInventoryRepairCommand.service.js'

const actorId = '507f1f77bcf86cd799439088'
const orderNumber = 'LC-2026-000123'
const route = `/api/admin/orders/${orderNumber}/attention/reassign-inventory`
let policyImportNonce = 0

const commandResult = (overrides = {}) => ({
  orderNumber,
  resolutionId: '507f1f77bcf86cd799439099',
  resolutionStatus: 'completed',
  action: 'reassign_inventory',
  outcome: 'completed',
  orderStatus: 'paid',
  paymentStatus: 'approved',
  fulfillmentStatus: 'preparing',
  repairAt: '2026-11-24T15:00:00.000Z',
  resolvedAt: '2026-11-24T15:00:00.000Z',
  attentionResolutionVersion: 1,
  summary: {
    alreadySoldCount: 1,
    preservedReservedCount: 0,
    reclaimedOriginalCount: 0,
    replacementCount: 0,
    soldCount: 1
  },
  idempotent: false,
  requestHash: 'must-not-leak',
  serialNumbers: ['must-not-leak'],
  ...overrides
})

const makeCommand = ({ result = commandResult(), error, validate = false } = {}) => {
  const calls = []
  return {
    calls,
    async repairApprovedOrderInventory(input) {
      calls.push(input)
      if (error) throw error
      if (validate) normalizeInventoryRepairCommandInput(input)
      return result
    }
  }
}

const createApp = ({ user, command }) => {
  const controller = new OrderAttentionController({
    orderInventoryRepairCommandService: command
  })
  const app = express()
  app.use(express.json())
  app.post(
    '/api/admin/orders/:orderNumber/attention/reassign-inventory',
    (req, _res, next) => {
      req.user = user
      next()
    },
    controller.reassignInventory
  )
  app.use(serviceErrorHandler)
  app.use((_error, _req, res, _next) => {
    assert.equal(typeof _next, 'function')
    res.status(500).json({ status: 'error', message: 'Error interno del servidor' })
  })
  return app
}

const invokeAdminPolicy = async (role) => {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  policyImportNonce += 1
  let handlePolicies
  try {
    const imported = await import(
      `../../src/config/handlePolicies.config.js?f3d=${policyImportNonce}`
    )
    handlePolicies = imported.default
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }

  const req = { cookies: {} }
  if (role) {
    req.cookies[env.cookie.name] = jwt.sign(
      { user: { id: actorId, role, email: `${role.toLowerCase()}@example.com` } },
      env.jwt.privateKey
    )
  }
  let status = null
  let payload = null
  let nextCalls = 0
  const res = {
    status(value) {
      status = value
      return this
    },
    json(value) {
      payload = value
      return this
    }
  }

  handlePolicies(['ADMIN'])(req, res, () => { nextCalls += 1 })
  return { req, status, payload, nextCalls }
}

describe('P1C-B0B F3-D admin inventory repair HTTP surface', () => {
  it('enforces the real ADMIN policy while preserving SUPERADMIN inheritance', async () => {
    const unauthenticated = await invokeAdminPolicy(null)
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticated.nextCalls, 0)

    for (const role of ['USER', 'PREMIUM']) {
      const denied = await invokeAdminPolicy(role)
      assert.equal(denied.status, 403)
      assert.equal(denied.nextCalls, 0)
      assert.equal(denied.req.user, undefined)
    }

    for (const role of ['ADMIN', 'SUPERADMIN']) {
      const allowed = await invokeAdminPolicy(role)
      assert.equal(allowed.status, null)
      assert.equal(allowed.payload, null)
      assert.equal(allowed.nextCalls, 1)
      assert.equal(allowed.req.user.role, role)
    }
  })

  for (const role of ['ADMIN', 'SUPERADMIN']) {
    it(`allows ${role} and forwards only authenticated identity and whitelisted input`, async () => {
      const command = makeCommand()
      const response = await request(createApp({
        user: { id: actorId, role },
        command
      }))
        .post(route)
        .set('Idempotency-Key', 'repair-http-key')
        .send({ note: 'Reviewed by operations' })

      assert.equal(response.status, 200)
      assert.deepEqual(command.calls, [{
        orderNumber,
        idempotencyKey: 'repair-http-key',
        actorUserId: actorId,
        actorRole: role,
        note: 'Reviewed by operations'
      }])
      assert.deepEqual(response.body, {
        orderNumber,
        resolutionId: '507f1f77bcf86cd799439099',
        resolutionStatus: 'completed',
        action: 'reassign_inventory',
        outcome: 'completed',
        orderStatus: 'paid',
        paymentStatus: 'approved',
        fulfillmentStatus: 'preparing',
        repairAt: '2026-11-24T15:00:00.000Z',
        resolvedAt: '2026-11-24T15:00:00.000Z',
        attentionResolutionVersion: 1,
        summary: {
          alreadySoldCount: 1,
          preservedReservedCount: 0,
          reclaimedOriginalCount: 0,
          replacementCount: 0,
          soldCount: 1
        },
        idempotent: false
      })
      assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false)
    })
  }

  it('uses req.user._id as the authenticated actor fallback', async () => {
    const command = makeCommand()
    const response = await request(createApp({
      user: { _id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-fallback-key')
      .send({})

    assert.equal(response.status, 200)
    assert.equal(command.calls[0].actorUserId, actorId)
  })

  it('returns the same safe DTO with idempotent true for a replay', async () => {
    const command = makeCommand({ result: commandResult({ idempotent: true }) })
    const response = await request(createApp({
      user: { id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-replay-key')
      .send({ note: 'same request' })

    assert.equal(response.status, 200)
    assert.equal(response.body.idempotent, true)
    assert.equal(command.calls.length, 1)
  })

  it('rejects an unauthenticated request before invoking the command', async () => {
    const command = makeCommand()
    const response = await request(createApp({ user: undefined, command }))
      .post(route)
      .set('Idempotency-Key', 'repair-no-actor')
      .send({})

    assert.equal(response.status, 401)
    assert.equal(command.calls.length, 0)
  })

  for (const role of ['USER', 'PREMIUM']) {
    it(`rejects ${role} before invoking the command`, async () => {
      const command = makeCommand()
      const response = await request(createApp({
        user: { id: actorId, role },
        command
      }))
        .post(route)
        .set('Idempotency-Key', `repair-${role.toLowerCase()}-key`)
        .send({})

      assert.equal(response.status, 403)
      assert.equal(command.calls.length, 0)
    })
  }

  it('rejects actor and inventory spoofing fields before invoking the command', async () => {
    const command = makeCommand()
    const response = await request(createApp({
      user: { id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-spoof-key')
      .send({
        actorUserId: '507f1f77bcf86cd799439077',
        actorRole: 'SUPERADMIN',
        paymentStatus: 'approved',
        replacementProductUnitIds: ['507f1f77bcf86cd799439066']
      })

    assert.equal(response.status, 400)
    assert.equal(command.calls.length, 0)
  })

  for (const testCase of [
    {
      name: 'missing Idempotency-Key',
      key: null,
      requestedOrderNumber: orderNumber,
      note: undefined
    },
    {
      name: 'invalid Idempotency-Key',
      key: 'bad key',
      requestedOrderNumber: orderNumber,
      note: undefined
    },
    {
      name: 'invalid orderNumber',
      key: 'repair-invalid-order',
      requestedOrderNumber: 'invalid-order',
      note: undefined
    },
    {
      name: 'note longer than 2000 characters',
      key: 'repair-long-note',
      requestedOrderNumber: orderNumber,
      note: 'x'.repeat(2001)
    }
  ]) {
    it(`returns 400 for ${testCase.name} through the real command input contract`, async () => {
      const command = makeCommand({ validate: true })
      const app = createApp({ user: { id: actorId, role: 'ADMIN' }, command })
      let pending = request(app)
        .post(`/api/admin/orders/${testCase.requestedOrderNumber}/attention/reassign-inventory`)
      if (testCase.key) pending = pending.set('Idempotency-Key', testCase.key)
      const response = await pending.send(
        testCase.note === undefined ? {} : { note: testCase.note }
      )

      assert.equal(response.status, 400)
      assert.equal(command.calls.length, 1)
    })
  }

  it('preserves domain note normalization at the command boundary', async () => {
    let normalized
    const command = {
      async repairApprovedOrderInventory(input) {
        normalized = normalizeInventoryRepairCommandInput(input)
        return commandResult()
      }
    }
    const response = await request(createApp({
      user: { id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-normalized-note')
      .send({ note: '  reviewed  ' })

    assert.equal(response.status, 200)
    assert.equal(normalized.note, 'reviewed')
  })

  for (const code of [
    'IDEMPOTENCY_KEY_REUSED',
    'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED',
    'INVENTORY_REPAIR_PLAN_BLOCKED',
    'INSUFFICIENT_REPAIR_INVENTORY',
    'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
  ]) {
    it(`preserves ${code} as an HTTP 409 domain conflict`, async () => {
      const error = new ServiceError(`Conflict ${code}`, code, 409)
      const command = makeCommand({ error })
      const response = await request(createApp({
        user: { id: actorId, role: 'ADMIN' },
        command
      }))
        .post(route)
        .set('Idempotency-Key', `repair-${code.toLowerCase().replaceAll('_', '-')}`)
        .send({})

      assert.equal(response.status, 409)
      assert.deepEqual(response.body, { status: 'error', message: `Conflict ${code}` })
      assert.equal(command.calls.length, 1)
    })
  }

  it('returns a safe 500 for INVENTORY_REPAIR_FAILED without internal diagnostics', async () => {
    const error = new ServiceError(
      'No fue posible completar la reparacion de inventario',
      'INVENTORY_REPAIR_FAILED',
      500,
      { topology: 'mongodb://private-host:27017', requestHash: 'private-hash' }
    )
    error.mongoCode = 112
    error.errorLabels = ['TransientTransactionError']
    const command = makeCommand({ error })
    const response = await request(createApp({
      user: { id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-domain-failure')
      .send({})
    const serialized = JSON.stringify(response.body)

    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      status: 'error',
      message: 'No fue posible completar la reparacion de inventario'
    })
    for (const forbidden of ['112', 'TransientTransactionError', 'mongodb://', 'private-hash']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })

  it('keeps an unexpected HTTP failure generic without exposing stack or details', async () => {
    const unexpected = new Error('private unexpected detail')
    unexpected.stack = 'private stack trace'
    unexpected.mongoCode = 112
    const command = makeCommand({ error: unexpected })
    const response = await request(createApp({
      user: { id: actorId, role: 'ADMIN' },
      command
    }))
      .post(route)
      .set('Idempotency-Key', 'repair-unexpected-http')
      .send({})
    const serialized = JSON.stringify(response.body)

    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      status: 'error',
      message: 'Error interno del servidor'
    })
    for (const forbidden of ['private unexpected detail', 'private stack trace', '112']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })

  it('forwards an unexpected error unchanged and does not write a controller response', async () => {
    const unexpected = new Error('unexpected internal detail')
    const command = makeCommand({ error: unexpected })
    const controller = new OrderAttentionController({
      orderInventoryRepairCommandService: command
    })
    let forwarded
    await controller.reassignInventory(
      {
        user: { id: actorId, role: 'ADMIN' },
        params: { orderNumber },
        get: () => 'repair-unexpected-key',
        body: {}
      },
      { status() { throw new Error('controller must not write the response') } },
      (error) => { forwarded = error }
    )

    assert.equal(forwarded, unexpected)
    assert.equal(command.calls.length, 1)
  })
})
