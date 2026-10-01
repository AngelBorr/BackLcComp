import CommerceCounterModel from '../models/commerceCounter.model.js'

class OrderNumberManager {
  async nextOrderNumber({ at = new Date(), session } = {}) {
    const date = new Date(at)

    if (Number.isNaN(date.getTime())) {
      throw new Error('Fecha inválida para generar número de orden')
    }

    const year = date.getUTCFullYear()
    const counter = await CommerceCounterModel.findOneAndUpdate(
      { _id: `order:${year}` },
      { $inc: { sequence: 1 } },
      { upsert: true, new: true, session, setDefaultsOnInsert: true }
    ).lean()

    return `LC-${year}-${String(counter.sequence).padStart(6, '0')}`
  }
}

export { OrderNumberManager }
export default new OrderNumberManager()
