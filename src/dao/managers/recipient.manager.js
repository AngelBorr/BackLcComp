// src/dao/managers/recipient.manager.js
import RecipientModel from '../models/model.recipient.js'

class RecipientManager {
  async getAll({ search, status, source, limit = 20, page = 1 }) {
    const parsedLimit = Math.max(Number(limit) || 20, 1)
    const parsedPage = Math.max(Number(page) || 1, 1)
    const skip = (parsedPage - 1) * parsedLimit

    const query = { isDeleted: false }

    if (status) query.status = status
    if (source) query.source = source

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { source: { $regex: search, $options: 'i' } }
      ]
    }

    const [items, total] = await Promise.all([
      RecipientModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      RecipientModel.countDocuments(query)
    ])

    return {
      items,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        pages: Math.max(Math.ceil(total / parsedLimit), 1)
      }
    }
  }

  async getById(id) {
    return RecipientModel.findOne({ _id: id, isDeleted: false }).lean()
  }

  async getByEmail(email) {
    return RecipientModel.findOne({
      email: email.toLowerCase().trim(),
      isDeleted: false
    }).lean()
  }

  async create(data) {
    return RecipientModel.create(data)
  }

  async bulkCreate(recipients) {
    return RecipientModel.insertMany(recipients, {
      ordered: false
    })
  }

  async update(id, data) {
    return RecipientModel.findOneAndUpdate({ _id: id, isDeleted: false }, data, {
      new: true,
      runValidators: true
    }).lean()
  }

  async softDelete(id) {
    return RecipientModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      {
        isDeleted: true,
        status: 'inactive'
      },
      { new: true }
    ).lean()
  }
}

export default RecipientManager
