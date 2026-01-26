import { getFileById, getInfoFileById, deleteFile } from '../controllers/controller.file.js'
import MyOwnRouter from './router.js'

export default class FilesRouter extends MyOwnRouter {
  init() {
    // ✅ OJO: rutas específicas primero (si no, /:id captura todo)
    this.get('/info/:id', ['ADMIN'], getInfoFileById)

    // Traer archivo por id (stream)
    this.get('/:id', ['PUBLIC'], getFileById)

    // Eliminar archivo por id (REST: DELETE /:id)
    this.delete('/:id', ['ADMIN'], deleteFile)
  }
}
