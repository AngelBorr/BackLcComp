import mongoose from 'mongoose'
import FileService from './service.files.js'
import FileAssetManager from '../dao/managers/fileAsset.mongo.js'

const fileAssetManager = new FileAssetManager()

export default class FileAssetService {
  static validateFile(file) {
    if (!file) {
      throw new Error('No se recibió ningún archivo')
    }

    if (!file.buffer || !Buffer.isBuffer(file.buffer)) {
      throw new Error('Archivo inválido: se esperaba un buffer')
    }

    if (!file.originalname) {
      throw new Error('El archivo no tiene nombre original')
    }

    if (!file.mimetype) {
      throw new Error('El archivo no tiene mimetype')
    }

    if (!file.size || file.size <= 0) {
      throw new Error('El archivo está vacío')
    }
  }

  static validateObjectId(id, label = 'ID') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error(`${label} inválido`)
    }
  }

  static buildSafeFilename(file) {
    const timestamp = Date.now()

    const cleanName = file.originalname
      .replace(/\s+/g, '-')
      .replace(/[^\w.-]/g, '')
      .toLowerCase()

    return `${timestamp}-${cleanName}`
  }

  static getDefaultVisibilityByModule(module) {
    const visibilityByModule = {
      catalog: 'premium',
      messenger: 'private',
      quote: 'private',
      billing: 'private',
      general: 'private'
    }

    return visibilityByModule[module] || 'private'
  }

  static canAccessAsset(asset, user = null) {
    if (!asset) return false

    const role = user?.role || user?.rol || user?.userRole || null

    if (asset.visibility === 'premium') {
      return ['PREMIUM', 'ADMIN'].includes(role)
    }

    if (asset.visibility === 'private') {
      return role === 'ADMIN'
    }

    if (asset.visibility === 'token') {
      return true
    }

    return false
  }

  static validateModule(module) {
    const allowedModules = ['catalog', 'messenger', 'quote', 'billing', 'general']

    if (!allowedModules.includes(module)) {
      throw new Error(`Módulo inválido: ${module}`)
    }
  }

  static validateVisibility(visibility) {
    const allowedVisibility = ['premium', 'private', 'token']

    if (!allowedVisibility.includes(visibility)) {
      throw new Error(`Visibilidad inválida: ${visibility}`)
    }
  }

  static validateModuleVisibility(module, visibility) {
    if (module === 'catalog' && visibility !== 'premium') {
      throw new Error('El catálogo solo puede tener visibilidad premium')
    }

    if (module !== 'catalog' && visibility === 'premium') {
      throw new Error('Solo el módulo catálogo puede tener visibilidad premium')
    }
  }

  static validateFileByModule({ file, module }) {
    if (module === 'catalog' && file.mimetype !== 'application/pdf') {
      throw new Error('El catálogo debe ser un archivo PDF')
    }

    if (module === 'quote' && file.mimetype !== 'application/pdf') {
      throw new Error('Las cotizaciones deben ser archivos PDF')
    }

    if (module === 'billing' && file.mimetype !== 'application/pdf') {
      throw new Error('Los archivos de facturación deben ser PDF')
    }
  }

  static async uploadGenericFile({
    file,
    module = 'general',
    entityType = null,
    entityId = null,
    visibility = null,
    uploadedBy = null,
    data = {}
  }) {
    this.validateFile(file)
    this.validateModule(module)

    const finalVisibility = visibility || this.getDefaultVisibilityByModule(module)

    this.validateVisibility(finalVisibility)
    this.validateModuleVisibility(module, finalVisibility)
    this.validateFileByModule({ file, module })

    if (entityId) {
      this.validateObjectId(entityId, 'entityId')
    }

    const filename = this.buildSafeFilename(file)

    const uploadResult = await FileService.uploadFile(file.buffer, filename, {
      originalName: file.originalname,
      contentType: file.mimetype,
      module,
      entityType,
      entityId,
      visibility: finalVisibility
    })

    if (!uploadResult?.success) {
      throw new Error(uploadResult?.error || 'Error subiendo archivo a GridFS')
    }

    const asset = await fileAssetManager.create({
      fileId: uploadResult.fileId,
      filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      module,
      entityType,
      entityId,
      visibility: finalVisibility,
      uploadedBy,
      data
    })

    return {
      success: true,
      data: asset
    }
  }

  static async uploadCatalogPdf({ file, uploadedBy = null, data = {} }) {
    this.validateFile(file)

    if (file.mimetype !== 'application/pdf') {
      throw new Error('El catálogo debe ser un archivo PDF')
    }

    await fileAssetManager.deactivatePreviousCatalogs()

    return await this.uploadGenericFile({
      file,
      module: 'catalog',
      entityType: 'catalog',
      entityId: null,
      visibility: 'premium',
      uploadedBy,
      data: {
        title: data.title || 'Catálogo LC COMP',
        catalogDate: data.catalogDate || new Date(),
        ...data
      }
    })
  }

  static async getAssetById(id) {
    this.validateObjectId(id, 'ID de asset')

    const asset = await fileAssetManager.getById(id)

    if (!asset) {
      throw new Error('Archivo no encontrado')
    }

    return {
      success: true,
      data: asset
    }
  }

  static async getActiveCatalog(user = null) {
    const catalog = await fileAssetManager.getActiveCatalog()

    if (!catalog) {
      throw new Error('No hay catálogo activo')
    }

    if (!this.canAccessAsset(catalog, user)) {
      throw new Error('No autorizado para acceder al catálogo')
    }

    return {
      success: true,
      data: catalog
    }
  }

  static async getStreamByAssetId(id, user = null) {
    this.validateObjectId(id, 'ID de archivo')

    const asset = await fileAssetManager.getById(id)

    if (!asset) {
      throw new Error('Archivo no encontrado')
    }

    if (!this.canAccessAsset(asset, user)) {
      throw new Error('No autorizado para acceder al archivo')
    }

    const fileResult = await FileService.getFileById(asset.fileId)

    if (!fileResult.success) {
      throw new Error(fileResult.error || 'Archivo físico no encontrado')
    }

    return {
      success: true,
      asset,
      fileInfo: fileResult.fileInfo,
      stream: fileResult.createDownloadStream()
    }
  }

  static async getStreamByFileId(fileId, user = null) {
    this.validateObjectId(fileId, 'ID de archivo')

    const asset = await fileAssetManager.getByFileId(fileId)

    if (!asset) {
      throw new Error('Archivo no encontrado')
    }

    if (!this.canAccessAsset(asset, user)) {
      throw new Error('No autorizado para acceder al archivo')
    }

    const fileResult = await FileService.getFileById(fileId)

    if (!fileResult.success) {
      throw new Error(fileResult.error || 'Archivo físico no encontrado')
    }

    return {
      success: true,
      asset,
      fileInfo: fileResult.fileInfo,
      stream: fileResult.createDownloadStream()
    }
  }

  static async getActiveCatalogStream(user = null) {
    const catalogResult = await this.getActiveCatalog(user)
    const catalog = catalogResult.data

    const fileResult = await FileService.getFileById(catalog.fileId)

    if (!fileResult.success) {
      throw new Error(fileResult.error || 'Archivo físico del catálogo no encontrado')
    }

    return {
      success: true,
      asset: catalog,
      fileInfo: fileResult.fileInfo,
      stream: fileResult.createDownloadStream()
    }
  }

  static async deleteAsset(id) {
    this.validateObjectId(id, 'ID de archivo')

    const asset = await fileAssetManager.softDelete(id)

    if (!asset) {
      throw new Error('Archivo no encontrado')
    }

    return {
      success: true,
      message: 'Archivo eliminado correctamente',
      data: asset
    }
  }

  static async getFilesByEntity({ module, entityType, entityId }) {
    if (!module || !entityType || !entityId) {
      throw new Error('module, entityType y entityId son requeridos')
    }

    this.validateModule(module)
    this.validateObjectId(entityId, 'entityId')

    const files = await fileAssetManager.getByEntity({
      module,
      entityType,
      entityId
    })

    return {
      success: true,
      data: files
    }
  }

  static async listFiles({ module, visibility, page = 1, limit = 20 }) {
    const filter = {}

    if (module) {
      this.validateModule(module)
      filter.module = module
    }

    if (visibility) {
      this.validateVisibility(visibility)
      filter.visibility = visibility
    }

    const result = await fileAssetManager.list(filter, { page, limit })

    return {
      success: true,
      data: result
    }
  }
}
