import UsersService from '../services/services.users.js'

const usersService = new UsersService()

export const getUsers = async (req, res) => {
  req.logger?.debug?.('[users.controller] getUsers')

  const users = await usersService.getUsers()

  return res.status(200).json({
    status: 'success',
    message: users.length
      ? 'Usuarios obtenidos correctamente.'
      : 'No se encontraron usuarios registrados.',
    data: users
  })
}

export const addUser = async (req, res) => {
  req.logger?.debug?.('[users.controller] addUser')

  const created = await usersService.addUser(req.body)

  return res.status(201).json({
    status: 'success',
    message: 'Usuario registrado correctamente.',
    data: created
  })
}

export const deleteUser = async (req, res) => {
  const { id } = req.params
  req.logger?.debug?.(`[users.controller] deleteUser id=${id}`)

  const deleted = await usersService.deleteUserById(id)

  if (!deleted) {
    return res.status(404).json({
      status: 'error',
      message: 'Usuario no encontrado.'
    })
  }

  return res.status(200).json({
    status: 'success',
    message: 'Usuario eliminado correctamente.'
  })
}

export const updateRole = async (req, res) => {
  const { id } = req.params
  req.logger?.debug?.(`[users.controller] updateRole id=${id}`)

  const updated = await usersService.updateRole(id, req.body)

  if (!updated) {
    return res.status(404).json({
      status: 'error',
      message: 'Usuario no encontrado.'
    })
  }

  return res.status(200).json({
    status: 'success',
    message: 'Rol actualizado correctamente.'
  })
}
