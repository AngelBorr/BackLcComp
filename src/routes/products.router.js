// routes/router.product.js
import MyOwnRouter from './router.js'
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  startSerialization,
  finishSerialization,
  deleteProduct
} from '../controllers/controller.products.js'

import { uploader } from '../utils/utils.js'

export default class ProductsRouter extends MyOwnRouter {
  init() {
    // ✅ Listar productos
    this.get('/', ['PUBLIC', 'ADMIN'], getProducts)

    // ✅ Obtener por ID
    this.get('/:id', ['PUBLIC'], getProductById)

    // ✅ Crear
    this.post('/', ['ADMIN'], uploader.array('images', 4), createProduct)

    // ✅ Actualizar
    this.put('/:id', ['ADMIN'], uploader.array('images', 4), updateProduct)

    this.post('/:id/start-serialization', ['ADMIN'], startSerialization)
    this.post('/:id/finish-serialization', ['ADMIN'], finishSerialization)

    // ✅ Eliminar (query opcional: deleteImages=true&soft=true)
    this.delete('/:id', ['ADMIN'], deleteProduct)
  }
}
