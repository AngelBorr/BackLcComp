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

export const registerPublicUser = async (req, res) => {
  req.logger?.debug?.('[users.controller] registerPublicUser')

  const result = await usersService.registerPublicUser(req.body)

  return res.status(201).json({
    status: 'success',
    message: result.verificationEmailSent
      ? 'Cuenta creada. Te enviamos un correo para verificar tu dirección.'
      : 'Cuenta creada, pero no pudimos enviar el correo de verificación. Podés solicitar uno nuevo.',
    data: result.user,
    emailVerification: {
      emailSent: result.verificationEmailSent
    }
  })
}

export const verifyEmail = async (req, res) => {
  req.logger?.debug?.('[users.controller] verifyEmail')

  await usersService.verifyEmail(req.body?.token)

  return res.status(200).json({
    status: 'success',
    message: 'Correo electrónico verificado correctamente.'
  })
}

export const resendEmailVerification = async (req, res) => {
  req.logger?.debug?.('[users.controller] resendEmailVerification')

  await usersService.resendEmailVerification(req.body?.email)

  return res.status(200).json({
    status: 'success',
    message:
      'Si existe una cuenta pendiente de verificación para ese correo, enviaremos un nuevo enlace.'
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
