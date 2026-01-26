import mongoose from 'mongoose'

export const connectBd = (uri) => {
  // conection mongoose server
  mongoose
    .connect(uri)
    .then(() => console.log('conectado a mongo'))
    .catch((err) => {
      console.log(err)
    })
}
