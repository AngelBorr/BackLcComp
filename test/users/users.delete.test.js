import request from 'supertest'
import { expect } from 'chai'
import app from '../../src/app.js'

describe('DELETE /api/users/:id', () => {
  let userId

  before(async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        firstName: 'Delete',
        lastName: 'Test',
        email: `testuser_${Date.now()}@lccomp-test.com`,
        password: '123456'
      })

    userId = res.body.data._id
  })

  it('debería eliminar un usuario existente', async () => {
    const res = await request(app).delete(`/api/users/${userId}`)

    expect(res.status).to.equal(200)
    expect(res.body.status).to.equal('success')
  })

  it('debería devolver 404 si el usuario no existe', async () => {
    const res = await request(app).delete(`/api/users/${userId}`)

    expect(res.status).to.equal(404)
  })
})
