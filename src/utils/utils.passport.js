import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import env from '../config.js'

export const PRIVATE_KEY = env.keyPrivate

export const createHash = password => bcrypt.hashSync(password, bcrypt.genSaltSync(10))

export const isValidPassword = (user, password) => {
  return bcrypt.compareSync(password, user.password)
}

export const generateToken = user => {
  const token = jwt.sign({ user }, `${PRIVATE_KEY}`, { expiresIn: '24h' })
  return token
}
