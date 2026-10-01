import MyOwnRouter from './router.js'
import ProductUnitController from '../controllers/productUnit.controller.js'

class ProductUnitRouter extends MyOwnRouter {
  init() {
    this.get('/product/:productId', ['ADMIN'], ProductUnitController.listByProduct)

    this.post('/product/:productId', ['ADMIN'], ProductUnitController.create)

    this.post('/product/:productId/bulk', ['ADMIN'], ProductUnitController.bulkCreate)

    this.put('/:unitId/status', ['ADMIN'], ProductUnitController.updateStatus)

    this.delete('/:unitId', ['ADMIN'], ProductUnitController.delete)
  }
}

export default ProductUnitRouter
