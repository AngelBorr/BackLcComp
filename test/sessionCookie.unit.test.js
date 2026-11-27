import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import jwt from 'jsonwebtoken'
import env, { resolveCookieConfig } from '../src/config.js'
import handlePolicies from '../src/config/handlePolicies.config.js'
import SessionsService from '../src/services/service.sessions.js'
import { logoutUser } from '../src/controllers/controller.sessions.js'

const withCookieConfig = async (cookieConfig, operation) => {
  const previous = { ...env.cookie }

  for (const key of Object.keys(env.cookie)) delete env.cookie[key]
  Object.assign(env.cookie, cookieConfig)

  try {
    return await operation()
  } finally {
    for (const key of Object.keys(env.cookie)) delete env.cookie[key]
    Object.assign(env.cookie, previous)
  }
}

describe('JWT cookie configuration (isolated unit tests)', () => {
  const environmentCases = [
    ['development', false, 'lax'],
    ['staging', true, 'none'],
    ['production', true, 'none']
  ]

  for (const [nodeEnvironment, secure, sameSite] of environmentCases) {
    it(`uses secure=${secure} and sameSite=${sameSite} in ${nodeEnvironment}`, () => {
      const cookie = resolveCookieConfig({ NODE_ENV: nodeEnvironment })

      assert.equal(cookie.secure, secure)
      assert.equal(cookie.sameSite, sameSite)
    })
  }

  it('parses COOKIE_SECURE=false as boolean false', () => {
    const cookie = resolveCookieConfig({
      NODE_ENV: 'staging',
      COOKIE_SECURE: 'false'
    })

    assert.equal(cookie.secure, false)
  })

  it('normalizes an explicit COOKIE_SAME_SITE=lax override', () => {
    const cookie = resolveCookieConfig({
      NODE_ENV: 'staging',
      COOKIE_SAME_SITE: 'lax'
    })

    assert.equal(cookie.sameSite, 'lax')
  })

  it('enforces the host-only cross-site HTTPS policy in production', () => {
    const cookie = resolveCookieConfig({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      COOKIE_SAME_SITE: 'strict',
      COOKIE_DOMAIN: 'lccomp.com.ar'
    })

    assert.equal(cookie.secure, true)
    assert.equal(cookie.sameSite, 'none')
    assert.equal(Object.hasOwn(cookie, 'domain'), false)
  })

  it('keeps the default development policy compatible with HTTP localhost', () => {
    const cookie = resolveCookieConfig({ NODE_ENV: 'development' })

    assert.equal(cookie.secure, false)
    assert.equal(cookie.sameSite, 'lax')
  })

  it('sets the production login cookie with cross-site attributes', async () => {
    const productionCookie = resolveCookieConfig({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      COOKIE_SAME_SITE: 'strict',
      COOKIE_DOMAIN: 'lccomp.com.ar'
    })
    let captured

    await withCookieConfig(productionCookie, async () => {
      await new SessionsService().generateAuthResponse({
        _id: '507f1f77bcf86cd799439011',
        firstName: 'Cookie',
        lastName: 'Production',
        email: 'cookie-production@example.invalid',
        role: 'USER'
      }, {
        cookie(name, token, options) {
          captured = { name, token, options }
        }
      })
    })

    assert.equal(captured.name, productionCookie.name)
    assert.equal(typeof captured.token, 'string')
    assert.deepEqual(captured.options, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: productionCookie.maxAge,
      path: '/'
    })
  })

  it('uses the centralized cookie configuration during login', async () => {
    let captured
    const response = {
      cookie(name, token, options) {
        captured = { name, token, options }
      }
    }

    await new SessionsService().generateAuthResponse({
      _id: '507f1f77bcf86cd799439011',
      firstName: 'Cookie',
      lastName: 'Test',
      email: 'cookie-test@example.invalid',
      role: 'USER'
    }, response)

    assert.equal(captured.name, env.cookie.name)
    assert.equal(typeof captured.token, 'string')
    assert.deepEqual(captured.options, {
      httpOnly: true,
      secure: env.cookie.secure,
      sameSite: env.cookie.sameSite,
      maxAge: env.cookie.maxAge,
      path: '/',
      ...(env.cookie.domain ? { domain: env.cookie.domain } : {})
    })
  })

  it('uses matching centralized attributes during logout', async () => {
    let cleared
    const response = {
      clearCookie(name, options) {
        cleared = { name, options }
      },
      status() {
        return this
      },
      json() {
        return this
      }
    }

    await logoutUser(
      { user: { email: 'cookie-test@example.invalid' } },
      response,
      (error) => { throw error }
    )

    assert.deepEqual(cleared, {
      name: env.cookie.name,
      options: {
        httpOnly: true,
        secure: env.cookie.secure,
        sameSite: env.cookie.sameSite,
        path: '/',
        ...(env.cookie.domain ? { domain: env.cookie.domain } : {})
      }
    })
  })

  it('clears the production cookie with matching cross-site attributes', async () => {
    const productionCookie = resolveCookieConfig({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      COOKIE_SAME_SITE: 'strict',
      COOKIE_DOMAIN: 'lccomp.com.ar'
    })
    let cleared

    await withCookieConfig(productionCookie, async () => {
      await logoutUser(
        { user: { email: 'cookie-production@example.invalid' } },
        {
          clearCookie(name, options) {
            cleared = { name, options }
          },
          status() {
            return this
          },
          json() {
            return this
          }
        },
        (error) => { throw error }
      )
    })

    assert.deepEqual(cleared, {
      name: productionCookie.name,
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/'
      }
    })
  })

  it('rejects a protected current-session request without the auth cookie', () => {
    const middleware = handlePolicies(['USER'])
    const response = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        this.body = body
        return this
      }
    }
    let nextCalls = 0

    middleware({ cookies: {} }, response, () => { nextCalls += 1 })

    assert.equal(nextCalls, 0)
    assert.equal(response.statusCode, 401)
    assert.equal(response.body.message, 'No autenticado. Cookie faltante.')
  })

  it('accepts a valid auth cookie for the current-session policy', () => {
    const middleware = handlePolicies(['USER'])
    const user = {
      id: '507f1f77bcf86cd799439011',
      email: 'cookie-current@example.invalid',
      role: 'USER'
    }
    const token = jwt.sign({ user }, env.jwt.privateKey, { expiresIn: '5m' })
    const request = { cookies: { [env.cookie.name]: token } }
    let nextCalls = 0

    middleware(request, {}, () => { nextCalls += 1 })

    assert.equal(nextCalls, 1)
    assert.deepEqual(request.user, user)
  })
})
