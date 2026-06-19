import FileAssetModel from '../models/fileAsset.model.js'

export default class FileAssetManager {
  async create(data) {
    return await FileAssetModel.create(data)
  }

  async getById(id) {
    return await FileAssetModel.findOne({
      _id: id,
      isDeleted: false
    }).lean()
  }

  async getByFileId(fileId) {
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
    return await FileAssetModel.find({
      module,
      entityType,
      entityId,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .lean()
  }

  async softDelete(id) {
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
      totalPages: Math.ceil(total / limit)
    }
  }
}
