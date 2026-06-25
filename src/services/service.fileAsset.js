import mongoose from 'mongoose'
import FileAssetManager from '../dao/managers/fileAsset.mongo.js'

const { GridFSBucket } = mongoose.mongo

const fileAssetManager = new FileAssetManager()
const bucketInstances = new Map()

export default class FileAssetService {
  static getBucketNameByModule(module) {
    const buckets = {
      catalog: 'lccompFilesCatalog',
      messenger: 'lccompFilesMessenger',
      quote: 'lccompFilesQuote',
      billing: 'lccompFilesBilling',
      general: 'lccompFilesGeneral'
    }

    return buckets[module] || buckets.general
  }

  static async ensureConnection() {
    if (mongoose.connection.readyState === 1) return

    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve)
      mongoose.connection.once('error', reject)
    })
  }

  static async getBucket(module = 'general') {
    this.validateModule(module)

    await this.ensureConnection()

    const bucketName = this.getBucketNameByModule(module)

    if (!bucketInstances.has(bucketName)) {
      const bucket = new GridFSBucket(mongoose.connection.db, {
        bucketName
      })

      bucketInstances.set(bucketName, bucket)
      console.log(`[FileAssetService] GridFSBucket creado: ${bucketName}`)
    }

    return bucketInstances.get(bucketName)
  }

  static async uploadBufferToGridFS({ file, filename, module, metadata = {} }) {
    this.validateFile(file)
    this.validateModule(module)

    const bucket = await this.getBucket(module)

    return await new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        metadata: {
          ...metadata,
          originalName: file.originalname,
          contentType: file.mimetype,
          size: file.size,
          module,
          uploadDate: new Date()
        }
      })

      uploadStream.on('error', reject)

      uploadStream.on('finish', () => {
        resolve({
          success: true,
          fileId: uploadStream.id,
          filename,
          bucketName: this.getBucketNameByModule(module),
          metadata
        })
      })

      uploadStream.end(file.buffer)
    })
  }

  static async getGridFsFileById({ fileId, module }) {
    this.validateObjectId(fileId, 'ID de archivo')
    this.validateModule(module)

    const bucket = await this.getBucket(module)
    const objectId = new mongoose.Types.ObjectId(fileId)

    const files = await bucket.find({ _id: objectId }).toArray()

    if (!files || files.length === 0) {
      throw new Error('Archivo físico no encontrado en GridFS')
    }

    const fileInfo = files[0]

    return {
      success: true,
      fileInfo: {
        id: fileInfo._id,
        filename: fileInfo.filename,
        length: fileInfo.length,
        uploadDate: fileInfo.uploadDate,
        contentType: fileInfo.metadata?.contentType,
        metadata: fileInfo.metadata || {}
      },
      createDownloadStream: () => bucket.openDownloadStream(objectId)
    }
  }

  static async deleteGridFsFileById({ fileId, module }) {
    this.validateObjectId(fileId, 'ID de archivo')
    this.validateModule(module)

    const bucket = await this.getBucket(module)
    const objectId = new mongoose.Types.ObjectId(fileId)

    const files = await bucket.find({ _id: objectId }).toArray()

    if (!files || files.length === 0) {
      throw new Error('Archivo físico no encontrado en GridFS')
    }

    await bucket.delete(objectId)

    return {
      success: true,
      deletedFileId: fileId,
      filename: files[0].filename
    }
  }

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

    const uploadResult = await this.uploadBufferToGridFS({
      file,
      filename,
      module,
      metadata: {
        originalName: file.originalname,
        contentType: file.mimetype,
        module,
        entityType,
        entityId,
        visibility: finalVisibility
      }
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
      data: {
        ...data,
        bucketName: uploadResult.bucketName
      }
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

  static async uploadMessengerAttachment({ file, uploadedBy = null, entityId = null, data = {} }) {
    const result = await this.uploadGenericFile({
      file,
      module: 'messenger',
      entityType: 'send',
      entityId,
      visibility: 'private',
      uploadedBy,
      data: {
        source: 'messenger_attachment',
        ...data
      }
    })

    const asset = result.data

    return {
      asset,
      fileAssetId: asset._id,
      fileId: asset.fileId,
      filename: asset.filename,
      originalName: asset.originalName,
      mimetype: asset.mimetype,
      size: asset.size
    }
  }

  static async uploadMessengerAttachments({
    files = [],
    uploadedBy = null,
    entityId = null,
    data = {}
  }) {
    if (!Array.isArray(files) || files.length === 0) {
      return []
    }

    const attachments = []

    for (const file of files) {
      const attachment = await this.uploadMessengerAttachment({
        file,
        uploadedBy,
        entityId,
        data
      })

      attachments.push(attachment)
    }

    return attachments
  }

  static async attachAssetsToSend(attachments = [], sendId) {
    const ids = attachments.map((item) => item.fileAssetId).filter(Boolean)

    if (!ids.length) return null

    return await fileAssetManager.attachToSend(ids, sendId)
  }

  static async getMessengerAssetsBySendId(sendId) {
    this.validateObjectId(sendId, 'sendId')

    return await fileAssetManager.getMessengerAssetsBySendId(sendId)
  }

  static streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
      const chunks = []

      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  static async getBufferByFileId(fileId, user = { role: 'ADMIN' }) {
    this.validateObjectId(fileId, 'ID de archivo')

    const streamResult = await this.getStreamByFileId(fileId, user)

    if (!streamResult?.success || !streamResult.stream) {
      throw new Error('No se pudo obtener el archivo adjunto')
    }

    return await this.streamToBuffer(streamResult.stream)
  }

  static async buildResendAttachmentsFromAssets(attachments = []) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return []
    }

    const resendAttachments = []

    for (const attachment of attachments) {
      if (!attachment.fileId) continue

      const buffer = await this.getBufferByFileId(attachment.fileId, { role: 'ADMIN' })

      resendAttachments.push({
        filename: attachment.originalName || attachment.filename,
        content: buffer.toString('base64')
      })
    }

    return resendAttachments
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

    const fileResult = await this.getGridFsFileById({
      fileId: asset.fileId,
      module: asset.module
    })

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

    const fileResult = await this.getGridFsFileById({
      fileId,
      module: asset.module
    })

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

    const fileResult = await this.getGridFsFileById({
      fileId: catalog.fileId,
      module: catalog.module
    })

    return {
      success: true,
      asset: catalog,
      fileInfo: fileResult.fileInfo,
      stream: fileResult.createDownloadStream()
    }
  }

  static async deleteAsset(id) {
    this.validateObjectId(id, 'ID de archivo')

    const asset = await fileAssetManager.getById(id)

    if (!asset) {
      throw new Error('Archivo no encontrado')
    }

    try {
      await this.deleteGridFsFileById({
        fileId: asset.fileId,
        module: asset.module
      })
    } catch (err) {
      console.warn(`[FileAssetService] No se pudo borrar archivo físico: ${err.message}`)
    }

    const deletedAsset = await fileAssetManager.softDelete(id)

    return {
      success: true,
      message: 'Archivo eliminado correctamente',
      data: deletedAsset
    }
  }

  static async deleteManyAssets(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return {
        success: true,
        message: 'No hay archivos para eliminar',
        data: null
      }
    }

    const result = await fileAssetManager.softDeleteMany(ids)

    return {
      success: true,
      message: 'Archivos eliminados correctamente',
      data: result
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
