/* eslint-env mocha */
import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'

const approvedAt = new Date('2026-11-18T15:00:00.000Z')
const paymentUpdatedAt = new Date('2026-11-18T15:00:01.000Z')
const reservationExpiresAt = new Date('2099-11-20T18:00:00.000Z')

const asId = (value) => String(value?._id ?? value).toLowerCase()
const epoch = (value) => value == null ? null : new Date(value).getTime()

describe('P1C-B0B F3-F controlled admin inventory repair E2E', function () {
  const harness = new MongoReplicaSetHarness()
  const serviceErrorLogs = []
  const externalRequests = []
  let fixtures
  let OrderAttentionResolutionModel
  let SessionsService
  let app
  let originalFetch
  let previousNodeEnv
  let sequence = 0

  before(async function () {
    previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    originalFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
      externalRequests.push(args)
      throw new Error('F3-F forbids external HTTP traffic')
    }

    await harness.start()
    fixtures = await import('../helpers/commerceFixtures.js')
    await fixtures.initializeCommerceModels()
    ;({ default: OrderAttentionResolutionModel } = await import(
      '../../../src/dao/models/orderAttentionResolution.model.js'
    ))
    await OrderAttentionResolutionModel.init()
    ;({ default: SessionsService } = await import('../../../src/services/service.sessions.js'))
    const { default: AdminOrdersRouter } = await import(
      '../../../src/routes/adminOrders.router.js'
    )
    const { serviceErrorHandler } = await import(
      '../../../src/middlewares/serviceErrorHandler.js'
    )

    app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use((req, _res, next) => {
      req.logger = {
        warn: (line) => serviceErrorLogs.push(line),
        error: (line) => serviceErrorLogs.push(line)
      }
      next()
    })
    app.use('/api/admin/orders', new AdminOrdersRouter().getRouter())
    app.use(serviceErrorHandler)
    app.use((_error, _req, res, next) => {
      assert.equal(typeof next, 'function')
      res.status(500).json({ status: 'error', message: 'Error interno del servidor' })
    })
  })

  afterEach(async function () {
    assert.equal(externalRequests.length, 0)
    serviceErrorLogs.length = 0
    await harness.cleanupCollections()
  })

  after(async function () {
    globalThis.fetch = originalFetch
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    await harness.stop()
  })

  const nextOrderNumber = () => {
    sequence += 1
    return `LC-2099-${String(sequence).padStart(6, '0')}`
  }

  const createAdmin = async () => {
    const actor = await fixtures.createSyntheticBuyer()
    actor.role = 'ADMIN'
    return actor.save()
  }

  const issueAuthCookie = async (user, role = user.role) => {
    let cookie
    const response = {
      cookie(name, value, options) {
        cookie = { name, value, options }
      }
    }
    await new SessionsService().generateAuthResponse(
      { ...user.toObject(), role },
      response
    )
    assert.equal(cookie.options.httpOnly, true)
    assert.equal(cookie.options.path, '/')
    return `${cookie.name}=${cookie.value}`
  }

  const setUnit = (unit, values) => fixtures.ProductUnitModel.findByIdAndUpdate(
    unit._id,
    { $set: values },
    { new: true, runValidators: true }
  ).lean()

  const syncStock = async (productId) => {
    const available = await fixtures.ProductUnitModel.countDocuments({
      productId,
      status: 'available',
      isDeleted: false
    })
    await fixtures.ProductModel.updateOne(
      { _id: productId },
      { $set: { prodStock: available } }
    )
    return available
  }

  const createCase = async ({
    unitCount = 2,
    captureLedger = true,
    deactivateOriginal = true
  } = {}) => {
    const buyer = await fixtures.createSyntheticBuyer()
    const actor = await createAdmin()
    const inventory = await fixtures.createSerializedInventory({
      buyerId: buyer._id,
      unitCount
    })
    const created = await fixtures.createBareOrderWithItem({
      buyer,
      product: inventory.product,
      quantity: 1,
      orderNumber: nextOrderNumber(),
      reservationExpiresAt
    })

    if (captureLedger) {
      await fixtures.captureSyntheticOriginalReservation({
        item: created.item,
        units: [inventory.units[0]],
        capturedAt: new Date('2026-11-18T14:30:00.000Z')
      })
    }
    await fixtures.markSyntheticOrderRequiresInventoryAttention({
      order: created.order,
      attentionReason: 'RESERVATION_QUANTITY_MISMATCH'
    })
    let payment = await fixtures.createSyntheticApprovedPayment({
      order: created.order,
      approvedAt
    })
    await fixtures.PaymentModel.collection.updateOne(
      { _id: payment._id },
      { $set: { updatedAt: paymentUpdatedAt } }
    )
    payment = await fixtures.PaymentModel.findById(payment._id)

    if (deactivateOriginal) await setUnit(inventory.units[0], { status: 'inactive' })
    await syncStock(inventory.product._id)

    return {
      buyer,
      actor,
      product: inventory.product,
      units: inventory.units,
      order: created.order,
      item: created.item,
      payment
    }
  }

  const snapshotCase = async (repairCase) => {
    const [order, payment, units, product, item, resolutions] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).lean(),
      fixtures.ProductUnitModel.find({ productId: repairCase.product._id })
        .sort({ _id: 1 })
        .lean(),
      fixtures.ProductModel.findById(repairCase.product._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean(),
      OrderAttentionResolutionModel.find({ orderId: repairCase.order._id })
        .sort({ createdAt: 1, _id: 1 })
        .lean()
    ])

    return {
      order: {
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
        paidAt: epoch(order.paidAt),
        attentionResolutionVersion: order.attentionResolutionVersion,
        statusHistory: (order.statusHistory || []).map((entry) => ({
          status: entry.status,
          changedAt: epoch(entry.changedAt),
          reason: entry.reason
        })),
        fulfillmentHistory: (order.fulfillmentHistory || []).map((entry) => ({
          status: entry.status,
          changedAt: epoch(entry.changedAt),
          changedBy: entry.changedBy == null ? null : asId(entry.changedBy),
          reason: entry.reason
        }))
      },
      payment: {
        normalizedStatus: payment.normalizedStatus,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        approvedAt: epoch(payment.approvedAt),
        amountArs: payment.amountArs.toString(),
        currency: payment.currency,
        updatedAt: epoch(payment.updatedAt)
      },
      units: units.map((unit) => ({
        id: asId(unit),
        status: unit.status,
        orderId: unit.orderId == null ? null : asId(unit.orderId),
        orderItemId: unit.orderItemId == null ? null : asId(unit.orderItemId),
        soldByOrderId: unit.soldByOrderId == null ? null : asId(unit.soldByOrderId),
        soldAt: epoch(unit.soldAt),
        isDeleted: unit.isDeleted
      })),
      stock: product.prodStock,
      ledger: fixtures.canonicalLedger(item.originalReservation),
      resolutions: resolutions.map((resolution) => ({
        id: asId(resolution),
        status: resolution.status,
        action: resolution.action,
        idempotencyKey: resolution.idempotencyKey,
        completedAt: epoch(resolution.completedAt)
      }))
    }
  }

  const assertStockInvariant = async (repairCase) => {
    const [product, available] = await Promise.all([
      fixtures.ProductModel.findById(repairCase.product._id).lean(),
      fixtures.ProductUnitModel.countDocuments({
        productId: repairCase.product._id,
        status: 'available',
        isDeleted: false
      })
    ])
    assert.equal(product.prodStock, available)
    return available
  }

  const assertResolutionInvariants = async (repairCase) => {
    const [completed, prepared, duplicateKeys] = await Promise.all([
      OrderAttentionResolutionModel.countDocuments({
        orderId: repairCase.order._id,
        action: 'reassign_inventory',
        status: 'completed'
      }),
      OrderAttentionResolutionModel.countDocuments({
        orderId: repairCase.order._id,
        status: 'prepared'
      }),
      OrderAttentionResolutionModel.aggregate([
        { $group: { _id: '$idempotencyKey', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
      ])
    ])
    assert.ok(completed <= 1)
    assert.equal(prepared, 0)
    assert.deepEqual(duplicateKeys, [])
  }

  const adminDetail = (repairCase, cookie) => request(app)
    .get(`/api/admin/orders/${repairCase.order.orderNumber}`)
    .set('Cookie', cookie)

  const postRepair = (repairCase, cookie, key, body = {}) => {
    let pending = request(app)
      .post(`/api/admin/orders/${repairCase.order.orderNumber}/attention/reassign-inventory`)
      .set('Cookie', cookie)
    if (key) pending = pending.set('Idempotency-Key', key)
    return pending.send(body)
  }

  const assertDomainError = (response, status, code) => {
    assert.equal(response.status, status)
    assert.ok(serviceErrorLogs.some((line) => line.includes(`| ${code} |`)))
    serviceErrorLogs.length = 0
  }

  it('crosses real auth, HTTP, command and Mongo with replay and conflict safety', async function () {
    const repairCase = await createCase()
    const adminCookie = await issueAuthCookie(repairCase.actor)
    const userCookie = await issueAuthCookie(repairCase.buyer, 'USER')
    const premiumCookie = await issueAuthCookie(repairCase.buyer, 'PREMIUM')
    const ledgerBefore = fixtures.canonicalLedger(
      (await fixtures.OrderItemModel.findById(repairCase.item._id).lean()).originalReservation
    )
    const initial = await snapshotCase(repairCase)
    const key = 'f3f-positive-repair-key'
    const note = 'E2E controlled inventory repair'

    const beforeDetail = await adminDetail(repairCase, adminCookie)
    assert.equal(beforeDetail.status, 200)
    assert.equal(beforeDetail.body.order.status, 'requires_attention')
    assert.equal(beforeDetail.body.order.fulfillmentStatus, 'pending')
    assert.equal(beforeDetail.body.attention.allowedActions.canReassignInventory, true)

    for (const cookie of [userCookie, premiumCookie]) {
      const denied = await postRepair(repairCase, cookie, key, { note })
      assert.equal(denied.status, 403)
      assert.deepEqual(await snapshotCase(repairCase), initial)
    }

    const spoofed = await postRepair(repairCase, adminCookie, key, {
      note: 'test',
      actorRole: 'SUPERADMIN',
      actorUserId: 'fake',
      paymentStatus: 'approved',
      replacementProductUnitIds: [asId(repairCase.units[1])]
    })
    assertDomainError(spoofed, 400, 'INVALID_ATTENTION_RESOLUTION_BODY')
    assert.deepEqual(await snapshotCase(repairCase), initial)

    const missingHeader = await postRepair(repairCase, adminCookie, null, { note })
    assertDomainError(
      missingHeader,
      400,
      'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED'
    )
    assert.deepEqual(await snapshotCase(repairCase), initial)

    const success = await postRepair(repairCase, adminCookie, key, { note })
    assert.equal(success.status, 200)
    assert.equal(success.body.idempotent, false)
    assert.equal(success.body.resolutionStatus, 'completed')
    assert.equal(success.body.action, 'reassign_inventory')
    assert.equal(success.body.orderStatus, 'paid')
    assert.equal(success.body.paymentStatus, 'approved')
    assert.equal(success.body.fulfillmentStatus, 'preparing')
    const successSerialized = JSON.stringify(success.body)
    for (const forbidden of [
      'serialNumber',
      repairCase.units[0].serialNumber,
      repairCase.units[1].serialNumber,
      'requestHash',
      'providerOrderId',
      'providerPaymentId'
    ]) assert.equal(successSerialized.includes(forbidden), false)

    const [order, payment, units, product, item, resolutions] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).lean(),
      fixtures.ProductUnitModel.find({ productId: repairCase.product._id }).lean(),
      fixtures.ProductModel.findById(repairCase.product._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean(),
      OrderAttentionResolutionModel.find({ orderId: repairCase.order._id }).lean()
    ])
    const sold = units.filter((unit) => unit.status === 'sold')
    assert.equal(order.status, 'paid')
    assert.equal(order.fulfillmentStatus, 'preparing')
    assert.equal(epoch(order.paidAt), epoch(payment.approvedAt))
    assert.equal(order.attentionResolutionVersion, 1)
    assert.equal(payment.normalizedStatus, 'approved')
    assert.equal(payment.providerPaymentId, repairCase.payment.providerPaymentId)
    assert.equal(epoch(payment.approvedAt), epoch(repairCase.payment.approvedAt))
    assert.equal(payment.amountArs.toString(), repairCase.payment.amountArs.toString())
    assert.equal(payment.currency, repairCase.payment.currency)
    assert.equal(epoch(payment.updatedAt), epoch(success.body.repairAt))
    assert.equal(sold.length, 1)
    assert.equal(asId(sold[0]), asId(repairCase.units[1]))
    assert.equal(asId(sold[0].soldByOrderId), asId(order))
    assert.equal(asId(sold[0].orderId), asId(order))
    assert.equal(asId(sold[0].orderItemId), asId(item))
    assert.equal(product.prodStock, 0)
    assert.equal(resolutions.length, 1)
    assert.equal(resolutions[0].status, 'completed')
    assert.equal(resolutions[0].action, 'reassign_inventory')
    assert.equal(resolutions[0].idempotencyKey, key)
    assert.equal(resolutions[0].inventoryRepairSummary.replacementCount, 1)
    assert.equal(resolutions[0].inventoryRepairSummary.soldCount, 1)
    assert.deepEqual(fixtures.canonicalLedger(item.originalReservation), ledgerBefore)
    await assertStockInvariant(repairCase)
    await assertResolutionInvariants(repairCase)

    const afterDetail = await adminDetail(repairCase, adminCookie)
    assert.equal(afterDetail.status, 200)
    assert.equal(afterDetail.body.order.status, 'paid')
    assert.equal(afterDetail.body.order.fulfillmentStatus, 'preparing')
    assert.equal(
      afterDetail.body.attention?.allowedActions?.canReassignInventory === true,
      false
    )

    const completedSnapshot = await snapshotCase(repairCase)
    const replay = await postRepair(repairCase, adminCookie, key, { note })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.idempotent, true)
    assert.deepEqual(await snapshotCase(repairCase), completedSnapshot)

    const changedRequest = await postRepair(repairCase, adminCookie, key, {
      note: 'different request'
    })
    assertDomainError(changedRequest, 409, 'IDEMPOTENCY_KEY_REUSED')
    assert.deepEqual(await snapshotCase(repairCase), completedSnapshot)

    const completedConflict = await postRepair(
      repairCase,
      adminCookie,
      'f3f-different-completed-key',
      { note }
    )
    assertDomainError(
      completedConflict,
      409,
      'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED'
    )
    assert.deepEqual(await snapshotCase(repairCase), completedSnapshot)
    await assertStockInvariant(repairCase)
    await assertResolutionInvariants(repairCase)
  })

  it('keeps the eligibility hint true while insufficient inventory rolls back fully', async function () {
    const repairCase = await createCase({ unitCount: 1 })
    const adminCookie = await issueAuthCookie(repairCase.actor)
    const before = await snapshotCase(repairCase)

    const detail = await adminDetail(repairCase, adminCookie)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.attention.allowedActions.canReassignInventory, true)

    const response = await postRepair(
      repairCase,
      adminCookie,
      'f3f-insufficient-inventory-key',
      { note: 'Insufficient inventory case' }
    )
    assertDomainError(response, 409, 'INSUFFICIENT_REPAIR_INVENTORY')
    assert.deepEqual(await snapshotCase(repairCase), before)
    assert.equal(await assertStockInvariant(repairCase), 0)
    await assertResolutionInvariants(repairCase)
  })

  it('allows SUPERADMIN policy but keeps a missing-ledger plan blocked without writes', async function () {
    const repairCase = await createCase({ captureLedger: false, deactivateOriginal: false })
    const superAdminCookie = await issueAuthCookie(repairCase.actor, 'SUPERADMIN')
    const before = await snapshotCase(repairCase)

    const detail = await adminDetail(repairCase, superAdminCookie)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.attention.allowedActions.canReassignInventory, true)

    const response = await postRepair(
      repairCase,
      superAdminCookie,
      'f3f-plan-blocked-key',
      { note: 'Missing immutable ledger' }
    )
    assertDomainError(response, 409, 'INVENTORY_REPAIR_PLAN_BLOCKED')
    assert.deepEqual(await snapshotCase(repairCase), before)
    assert.equal(await assertStockInvariant(repairCase), 2)
    await assertResolutionInvariants(repairCase)
  })
})
