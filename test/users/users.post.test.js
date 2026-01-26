import request from 'supertest'
import { expect } from 'chai'
import app from '../../src/app.js'

describe('POST /api/users', () => {
  const userMock = {
    firstName: 'Test',
    lastName: 'User',
    email: `testuser_${Date.now()}@lccomp-test.com`,
    password: '123456',
    role: 'USER'
  }

  it('debería crear un usuario correctamente', async () => {
    const res = await request(app).post('/api/users').send(userMock)

    expect(res.status).to.equal(201)
    expect(res.body.status).to.equal('success')
    expect(res.body.data).to.have.property('email', userMock.email)
    expect(res.body.data).to.not.have.property('password')
  })

  it('no debería permitir crear usuario duplicado', async () => {
    const res = await request(app).post('/api/users').send(userMock)

    expect(res.status).to.equal(409)
    expect(res.body.status).to.equal('error')
  })
})
