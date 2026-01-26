import mongoose from 'mongoose'
import FileService from '../services/service.files.js'

export const getFileById = async (req, res) => {
  try {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'ID de archivo inválido' })
    }

    const gfsBucket = await FileService.ensureBucket()

    const objectId = new mongoose.Types.ObjectId(id)
    const files = await gfsBucket.find({ _id: objectId }).toArray()

    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado' })
    }

    const file = files[0]

    res.set('Content-Type', file.metadata?.contentType || 'application/octet-stream')
    res.set('Content-Disposition', `inline; filename="${file.filename}"`)
    res.set('Cache-Control', 'public, max-age=86400')

    // ✅ usar el bucket real (no req.gfsBucket)
    const downloadStream = gfsBucket.openDownloadStream(objectId)

    downloadStream.on('error', (err) => {
      console.error('Error en stream de descarga:', err)
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Error al descargar el archivo' })
      }
    })

    downloadStream.pipe(res)
  } catch (err) {
    console.error('Error descargando archivo:', err)
    res.status(500).json({ success: false, error: 'Error interno del servidor' })
  }
}

export const getInfoFileById = async (req, res) => {
  try {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'ID de archivo inválido' })
    }

    const gfsBucket = await FileService.ensureBucket()
    const objectId = new mongoose.Types.ObjectId(id)

    const files = await gfsBucket.find({ _id: objectId }).toArray()

    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado' })
    }

    const f = files[0]

    return res.status(200).json({
      success: true,
      data: {
        id: f._id,
        filename: f.filename,
        uploadDate: f.uploadDate,
        metadata: f.metadata || {},
        length: f.length,
        contentType: f.metadata?.contentType,
        chunkSize: f.chunkSize
      }
    })
  } catch (err) {
    console.error('Error obteniendo información del archivo:', err)
    res.status(500).json({ success: false, error: 'Error interno del servidor' })
  }
}

export const deleteFile = async (req, res) => {
  try {
    const { id } = req.params

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'ID de archivo inválido' })
    }

    const gfsBucket = await FileService.ensureBucket()
    const objectId = new mongoose.Types.ObjectId(id)

    // (opcional) verificar que exista antes
    const files = await gfsBucket.find({ _id: objectId }).toArray()
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado' })
    }

    await gfsBucket.delete(objectId)

    return res.status(200).json({
      success: true,
      message: 'Archivo eliminado correctamente',
      deletedFileId: id,
      filename: files[0].filename
    })
  } catch (err) {
    console.error('Error eliminando archivo:', err)
    res.status(500).json({ success: false, error: 'Error interno del servidor' })
  }
}
