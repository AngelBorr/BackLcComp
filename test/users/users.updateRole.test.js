import request from 'supertest'
import { expect } from 'chai'
import app from '../../src/app.js'

describe('PUT /api/users/role/:id', () => {
  let userId

  before(async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        firstName: 'Role',
        lastName: 'Test',
        email: `testuser_${Date.now()}@lccomp-test.com`,
        password: '123456'
      })

    userId = res.body.data._id
  })

  it('debería actualizar el rol del usuario', async () => {
    const res = await request(app).put(`/api/users/role/${userId}`).send({ role: 'PREMIUM' })

    expect(res.status).to.equal(200)
    expect(res.body.status).to.equal('success')
  })

  it('no debería aceptar un rol inválido', async () => {
    const res = await request(app).put(`/api/users/role/${userId}`).send({ role: 'INVALID_ROLE' })

    expect(res.status).to.equal(400)
    expect(res.body.status).to.equal('error')
  })
})
