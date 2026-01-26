// routes/router.product.js
import MyOwnRouter from './router.js'
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
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

    // ✅ Eliminar (query opcional: deleteImages=true&soft=true)
    this.delete('/:id', ['ADMIN'], deleteProduct)
  }
}
