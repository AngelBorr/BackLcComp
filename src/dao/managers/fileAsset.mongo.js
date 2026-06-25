import mongoose from 'mongoose'
import FileAssetModel from '../models/fileAsset.model.js'

export default class FileAssetManager {
  async create(data) {
    return await FileAssetModel.create(data)
  }

  async getById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null

    return await FileAssetModel.findOne({
      _id: id,
      isDeleted: false
    }).lean()
  }

  async getByFileId(fileId) {
    if (!mongoose.Types.ObjectId.isValid(fileId)) return null

    return await FileAssetModel.findOne({
      fileId,
      isDeleted: false
    }).lean()
  }

  async getActiveCatalog() {
    return await FileAssetModel.findOne({
      module: 'catalog',
      visibility: 'premium',
      isActive: true,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .lean()
  }

  async deactivatePreviousCatalogs() {
    return await FileAssetModel.updateMany(
      {
        module: 'catalog',
        isActive: true,
        isDeleted: false
      },
      {
        $set: { isActive: false }
      }
    )
  }

  async getByEntity({ module, entityType, entityId }) {
    if (!module || !entityType || !mongoose.Types.ObjectId.isValid(entityId)) {
      return []
    }

    return await FileAssetModel.find({
      module,
      entityType,
      entityId,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .lean()
  }

  async getMessengerAssetsBySendId(sendId) {
    if (!mongoose.Types.ObjectId.isValid(sendId)) {
      return []
    }

    return await this.getByEntity({
      module: 'messenger',
      entityType: 'send',
      entityId: sendId
    })
  }

  async attachToEntity(ids = [], { entityType, entityId }) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return null
    }

    if (!entityType || !mongoose.Types.ObjectId.isValid(entityId)) {
      return null
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id))

    if (validIds.length === 0) {
      return null
    }

    return await FileAssetModel.updateMany(
      {
        _id: { $in: validIds },
        isDeleted: false
      },
      {
        $set: {
          entityType,
          entityId
        }
      }
    )
  }

  async attachToSend(ids = [], sendId) {
    return await this.attachToEntity(ids, {
      entityType: 'send',
      entityId: sendId
    })
  }

  async updateData(id, data = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null
    }

    return await FileAssetModel.findOneAndUpdate(
      {
        _id: id,
        isDeleted: false
      },
      {
        $set: {
          data
        }
      },
      { new: true }
    ).lean()
  }

  async mergeData(id, data = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null
    }

    const asset = await FileAssetModel.findOne({
      _id: id,
      isDeleted: false
    })

    if (!asset) return null

    asset.data = {
      ...(asset.data || {}),
      ...data
    }

    await asset.save()

    return asset.toObject()
  }

  async softDelete(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null
    }

    return await FileAssetModel.findByIdAndUpdate(
      id,
      {
        $set: {
          isDeleted: true,
          isActive: false
        }
      },
      { new: true }
    ).lean()
  }

  async softDeleteMany(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return null
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id))

    if (!validIds.length) return null

    return await FileAssetModel.updateMany(
      {
        _id: { $in: validIds },
        isDeleted: false
      },
      {
        $set: {
          isDeleted: true,
          isActive: false
        }
      }
    )
  }

  async list(filter = {}, options = {}) {
    const page = Number(options.page) || 1
    const limit = Number(options.limit) || 20
    const skip = (page - 1) * limit

    const query = {
      isDeleted: false,
      ...filter
    }

    const [items, total] = await Promise.all([
      FileAssetModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FileAssetModel.countDocuments(query)
    ])

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1
    }
  }
}
