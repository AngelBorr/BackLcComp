import { Router } from 'express'
import handlePolicies from '../config/handlePolicies.config.js'

class MyOwnRouter {
  constructor() {
    this.router = Router()
    this.init()
  }

  getRouter() {
    return this.router
  }

  init() {}

  /**
   * Aplica un try/catch automático a todos los callbacks.
   */
  applyCallbacks(callbacks) {
    return callbacks.map((callback) => async (...params) => {
      try {
        await callback.apply(this, params)
      } catch (error) {
        console.error('Error en ruta:', error)
        const res = params[1]
        res.status(500).json({
          status: 'error',
          message: error.message || 'Error interno del servidor'
        })
      }
    })
  }

  /**
   * Registra rutas con control de políticas + callbacks seguros.
   */
  get(path, policies, ...callbacks) {
    this.router.get(path, handlePolicies(policies), this.applyCallbacks(callbacks))
  }

  post(path, policies, ...callbacks) {
    this.router.post(path, handlePolicies(policies), this.applyCallbacks(callbacks))
  }

  put(path, policies, ...callbacks) {
    this.router.put(path, handlePolicies(policies), this.applyCallbacks(callbacks))
  }

  delete(path, policies, ...callbacks) {
    this.router.delete(path, handlePolicies(policies), this.applyCallbacks(callbacks))
  }
}

export default MyOwnRouter
