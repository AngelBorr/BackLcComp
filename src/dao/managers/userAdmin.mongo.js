import userAdminModel from '../models/userAdmin.model.js'

class UserAdminManager {
  constructor() {
    this.userAdmin = userAdminModel
  }

  // trae a todos los usuarios (sin password)
  async getAllUsers() {
    return this.userAdmin.find().select('-password').lean()
  }

  // crea al usuario
  async createUser(bodyUser) {
    return this.userAdmin.create(bodyUser)
  }

  // trae al usuario por su id (sin password)
  async getUserById(id) {
    return this.userAdmin.findById(id).select('-password').lean()
  }

  // eliminar un usuario
  async deleteUser(id) {
    return this.userAdmin.deleteOne({ _id: id })
  }

  // trae al usuario por su email (sin password)
  async getUserForEmail(email) {
    return this.userAdmin.findOne({ email }).select('-password').lean()
  }

  // ✅ para login/auth (incluye password aunque esté select:false)
  async getUserForAuth(email) {
    return this.userAdmin.findOne({ email }).select('+password').lean()
  }

  // ✅ actualizar usuario (sin password)
  async updateUser(id, data) {
    return this.userAdmin.findByIdAndUpdate(id, data, { new: true }).select('-password').lean()
  }
}

export default UserAdminManager
