/* eslint-env mocha */
import request from 'supertest'
import { expect } from 'chai'
import app from '../../src/app.js'

describe('Users API - casos borde', () => {
  const uniqueEmail = () =>
    `test_${Date.now()}_${Math.random().toString(16).slice(2)}@lccomp-test.com`

  describe('POST /api/users', () => {
    it('400 si faltan campos requeridos (sin password)', async () => {
      const res = await request(app).post('/api/users').send({
        firstName: 'Edge',
        lastName: 'Case',
        email: uniqueEmail()
      })

      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })

    it('400 si payload es null', async () => {
      const res = await request(app).post('/api/users').send(null)
      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })

    it('400 si rol inválido', async () => {
      const res = await request(app).post('/api/users').send({
        firstName: 'Edge',
        lastName: 'Role',
        email: uniqueEmail(),
        password: '123456',
        role: 'INVALID_ROLE'
      })

      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })
  })

  describe('DELETE /api/users/:id', () => {
    it('400 si id no es ObjectId válido', async () => {
      const res = await request(app).delete('/api/users/not-an-objectid')
      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })

    it('404 si id es válido pero no existe', async () => {
      const fakeId = '507f1f77bcf86cd799439011'
      const res = await request(app).delete(`/api/users/${fakeId}`)
      expect(res.status).to.equal(404)
      expect(res.body.status).to.equal('error')
    })
  })

  describe('PUT /api/users/role/:id', () => {
    it('400 si id no es ObjectId válido', async () => {
      const res = await request(app).put('/api/users/role/invalid-id').send({ role: 'ADMIN' })

      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })

    it('400 si falta role', async () => {
      const create = await request(app).post('/api/users').send({
        firstName: 'Edge',
        lastName: 'MissingRole',
        email: uniqueEmail(),
        password: '123456'
      })

      expect(create.status).to.equal(201)
      const id = create.body?.data?._id
      expect(id).to.be.a('string')

      const res = await request(app).put(`/api/users/role/${id}`).send({})
      expect(res.status).to.equal(400)
      expect(res.body.status).to.equal('error')
    })

    it('404 si id válido pero no existe', async () => {
      const fakeId = '507f1f77bcf86cd799439011'
      const res = await request(app).put(`/api/users/role/${fakeId}`).send({ role: 'PREMIUM' })

      expect(res.status).to.equal(404)
      expect(res.body.status).to.equal('error')
    })
  })
})
