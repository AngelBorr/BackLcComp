import request from 'supertest'
import { expect } from 'chai'
import app from '../../src/app.js'

describe('GET /api/users', () => {
  it('debería devolver un array de usuarios', async () => {
    const res = await request(app).get('/api/users')

    expect(res.status).to.equal(200)
    expect(res.body).to.have.property('status', 'success')
    expect(res.body.data).to.be.an('array')
  })
})
