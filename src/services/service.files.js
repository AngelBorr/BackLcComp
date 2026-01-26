import mongoose from 'mongoose'

const { GridFSBucket } = mongoose.mongo

let gfsBucketInstance = null

export default class FileService {
  static getBucket() {
    if (!gfsBucketInstance && mongoose.connection.readyState === 1) {
      gfsBucketInstance = new GridFSBucket(mongoose.connection.db, {
        bucketName: 'productFiles'
      })
      console.log('GridFSBucket creado desde servicio')
    }
    return gfsBucketInstance
  }

  static async ensureBucket() {
    if (gfsBucketInstance) return gfsBucketInstance

    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve) => {
        mongoose.connection.once('connected', resolve)
      })
    }

    console.log('[FileService] Mongo readyState:', mongoose.connection.readyState)
    console.log('[FileService] DB name:', mongoose.connection?.db?.databaseName)

    gfsBucketInstance = new GridFSBucket(mongoose.connection.db, { bucketName: 'productFiles' })
    return gfsBucketInstance
  }

  static async getFileById(fileId) {
    try {
      const bucket = await this.ensureBucket()
      const objectId = new mongoose.Types.ObjectId(fileId)

      const files = await bucket.find({ _id: objectId }).toArray()
      if (!files || files.length === 0) throw new Error('Archivo no encontrado en GridFS')

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
    } catch (error) {
      console.error('Error en getFileById:', error.message)
      return { success: false, error: error.message }
    }
  }

  static async getFileInfoById(fileId) {
    try {
      const bucket = await this.ensureBucket()

      if (!mongoose.Types.ObjectId.isValid(fileId)) {
        throw new Error('ID de archivo inválido')
      }

      const objectId = new mongoose.Types.ObjectId(fileId)
      const files = await bucket.find({ _id: objectId }).toArray()

      if (!files || files.length === 0) throw new Error('Archivo no encontrado')

      const fileInfo = files[0]
      return {
        success: true,
        data: {
          id: fileInfo._id,
          filename: fileInfo.filename,
          uploadDate: fileInfo.uploadDate,
          length: fileInfo.length,
          contentType: fileInfo.metadata?.contentType,
          metadata: fileInfo.metadata || {},
          chunkSize: fileInfo.chunkSize
        }
      }
    } catch (error) {
      console.error('Error en getFileInfoById:', error.message)
      return { success: false, error: error.message }
    }
  }

  static async deleteFileById(fileId) {
    try {
      const bucket = await this.ensureBucket()

      if (!mongoose.Types.ObjectId.isValid(fileId)) {
        throw new Error('ID de archivo inválido')
      }

      const objectId = new mongoose.Types.ObjectId(fileId)

      const files = await bucket.find({ _id: objectId }).toArray()
      if (!files || files.length === 0) throw new Error('Archivo no encontrado')

      await bucket.delete(objectId)

      return {
        success: true,
        message: 'Archivo eliminado correctamente',
        deletedFileId: fileId,
        filename: files[0].filename
      }
    } catch (error) {
      console.error('Error en deleteFileById:', error.message)
      return { success: false, error: error.message }
    }
  }

  static async uploadFile(fileBuffer, filename, metadata = {}) {
    const bucket = await this.ensureBucket()

    // ✅ Validaciones duras (esto te va a decir en 1 segundo si el problema es el tipo)
    const isBuf = Buffer.isBuffer(fileBuffer)
    const len = isBuf ? fileBuffer.length : undefined

    console.log('[FileService.uploadFile] start', {
      filename,
      isBuffer: isBuf,
      type: typeof fileBuffer,
      length: len,
      metaKeys: Object.keys(metadata || {})
    })

    if (!isBuf) {
      console.log('[FileService.uploadFile] ❌ fileBuffer NO es Buffer. Valor:', fileBuffer)
      throw new Error(
        'uploadFile: fileBuffer must be a Buffer (multer memoryStorage -> file.buffer)'
      )
    }

    // (opcional) firma rápida de PNG/JPG
    console.log('[FileService.uploadFile] head hex:', fileBuffer.subarray(0, 12).toString('hex'))

    return await new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        metadata: {
          ...metadata,
          uploadDate: new Date(),
          originalName: filename
        }
      })

      console.log('[FileService.uploadFile] stream created', { id: String(uploadStream.id) })

      let settled = false
      const done = (err, payload) => {
        if (settled) return
        settled = true
        if (err) {
          console.log('[FileService.uploadFile] done ERROR', err)
          return reject(err)
        }
        console.log('[FileService.uploadFile] done OK', payload)
        return resolve(payload)
      }

      // ✅ Logueá TODOS los eventos importantes
      uploadStream.on('finish', () => console.log('[FileService.uploadFile] event: finish'))
      uploadStream.on('close', () => console.log('[FileService.uploadFile] event: close'))
      uploadStream.on('error', (err) => {
        console.log('[FileService.uploadFile] event: error', err)
        done(err instanceof Error ? err : new Error(String(err)))
      })

      // ✅ Timeout para evitar “cuelgue silencioso”
      const t = setTimeout(() => {
        console.log('[FileService.uploadFile] ❌ TIMEOUT 15s (no finish/close/error)')
        done(new Error('GridFS upload timeout (15s)'))
      }, 15000)

      const clear = () => clearTimeout(t)
      uploadStream.once('finish', () => {
        clear()
        done(null, {
          success: true,
          fileId: uploadStream.id,
          filename,
          metadata
        })
      })
      uploadStream.once('close', () => {
        // si por alguna razón close llega primero
        clear()
        if (!settled) {
          done(null, {
            success: true,
            fileId: uploadStream.id,
            filename,
            metadata
          })
        }
      })

      // ✅ Subida (end(buffer) está perfecto)
      try {
        uploadStream.end(fileBuffer)
        console.log('[FileService.uploadFile] end(buffer) called')
      } catch (e) {
        clear()
        done(e)
      }
    })
  }

  static async getAllFiles(filter = {}) {
    try {
      const bucket = await this.ensureBucket()
      const files = await bucket.find(filter).toArray()

      return {
        success: true,
        files: files.map((file) => ({
          id: file._id,
          filename: file.filename,
          uploadDate: file.uploadDate,
          length: file.length,
          contentType: file.metadata?.contentType,
          metadata: file.metadata || {}
        })),
        count: files.length
      }
    } catch (error) {
      console.error('Error en getAllFiles:', error.message)
      return { success: false, error: error.message }
    }
  }

  static async findFilesByMetadata(metadataQuery) {
    try {
      const bucket = await this.ensureBucket()
      const files = await bucket.find({ metadata: { $exists: true, ...metadataQuery } }).toArray()

      return {
        success: true,
        files: files.map((file) => ({
          id: file._id,
          filename: file.filename,
          uploadDate: file.uploadDate,
          metadata: file.metadata || {}
        })),
        count: files.length
      }
    } catch (error) {
      console.error('Error en findFilesByMetadata:', error.message)
      return { success: false, error: error.message }
    }
  }

  static async fileExists(fileId) {
    try {
      const bucket = await this.ensureBucket()

      if (!mongoose.Types.ObjectId.isValid(fileId)) {
        return { success: false, exists: false }
      }

      const objectId = new mongoose.Types.ObjectId(fileId)
      const files = await bucket.find({ _id: objectId }).toArray()

      return {
        success: true,
        exists: files && files.length > 0,
        file: files && files.length > 0 ? files[0] : null
      }
    } catch (error) {
      console.error('Error en fileExists:', error.message)
      return { success: false, error: error.message }
    }
  }
}
