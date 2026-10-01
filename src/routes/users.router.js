import { asyncHandler } from '../middlewares/asyncHandler.js'
import {
  addUser,
  registerPublicUser,
  verifyEmail,
  resendEmailVerification,
  updateRole,
  getUsers,
  deleteUser
} from '../controllers/users.controller.js'
import MyOwnRouter from './router.js'

export default class UsersRouter extends MyOwnRouter {
  init() {
    // ruta get debera traer a todos los usuarios
    this.get('/', ['ADMIN'], asyncHandler(getUsers))

    // ruta post debera crear un usuario
    this.post('/register', ['ADMIN'], asyncHandler(addUser))

    // registro público: el backend fuerza siempre el rol USER
    this.post('/public-register', ['PUBLIC'], asyncHandler(registerPublicUser))

    this.post('/verify-email', ['PUBLIC'], asyncHandler(verifyEmail))

    this.post(
      '/resend-verification',
      ['PUBLIC'],
      asyncHandler(resendEmailVerification)
    )

    // ruta delete debera eliminar a un usuario por su id
    this.delete('/:id', ['ADMIN'], asyncHandler(deleteUser))

    // la ruta put debera actualizar el rol del usuario
    this.put('/role/:id', ['ADMIN'], asyncHandler(updateRole))
  }
}
