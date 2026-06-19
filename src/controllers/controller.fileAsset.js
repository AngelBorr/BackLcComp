import FileAssetService from '../services/service.fileAsset.js'

const getUserId = (req) => {
  return req.user?._id || req.user?.id || req.user?.userId || null
}

const parseJsonData = (rawData) => {
  if (!rawData) return {}

  if (typeof rawData === 'object') return rawData

  try {
    return JSON.parse(rawData)
  } catch {
    return {}
  }
}

export const uploadFileAsset = async (req, res) => {
  try {
    const { module, entityType, entityId, visibility } = req.body

    const result = await FileAssetService.uploadGenericFile({
      file: req.file,
      module: module || 'general',
      entityType: entityType || null,
      entityId: entityId || null,
      visibility: visibility || null,
      uploadedBy: getUserId(req),
      data: parseJsonData(req.body.data)
    })

    return res.status(201).json(result)
  } catch (err) {
    console.error('Error en uploadFileAsset:', err)

    return res.status(400).json({
      success: false,
      error: err.message || 'Error subiendo archivo'
    })
  }
}

export const uploadCatalogPdf = async (req, res) => {
  try {
    const result = await FileAssetService.uploadCatalogPdf({
      file: req.file,
      uploadedBy: getUserId(req),
      data: parseJsonData(req.body.data)
    })

    return res.status(201).json({
      success: true,
      message: 'Catálogo cargado correctamente',
      data: result.data
    })
  } catch (err) {
    console.error('Error en uploadCatalogPdf:', err)

    return res.status(400).json({
      success: false,
      error: err.message || 'Error subiendo catálogo'
    })
  }
}

export const getActiveCatalog = async (req, res) => {
  try {
    const result = await FileAssetService.getActiveCatalog(req.user)

    return res.status(200).json(result)
  } catch (err) {
    return res.status(404).json({
      success: false,
      error: err.message || 'No hay catálogo activo'
    })
  }
}

export const streamActiveCatalog = async (req, res) => {
  try {
    const result = await FileAssetService.getActiveCatalogStream(req.user)

    const { asset, stream } = result

    res.set('Content-Type', asset.mimetype || 'application/pdf')
    res.set('Content-Disposition', `inline; filename="${asset.originalName}"`)
    res.set('Cache-Control', 'private, no-store')

    stream.on('error', (err) => {
      console.error('Error en streamActiveCatalog:', err)

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Error al leer catálogo'
        })
      }
    })

    return stream.pipe(res)
  } catch (err) {
    console.error('Error en streamActiveCatalog:', err)

    return res.status(404).json({
      success: false,
      error: err.message || 'No hay catálogo activo'
    })
  }
}

export const getFileAssetById = async (req, res) => {
  try {
    const { id } = req.params

    const result = await FileAssetService.getAssetById(id)

    return res.status(200).json(result)
  } catch (err) {
    return res.status(404).json({
      success: false,
      error: err.message || 'Archivo no encontrado'
    })
  }
}

export const streamFileAssetById = async (req, res) => {
  try {
    const { id } = req.params

    const result = await FileAssetService.getStreamByAssetId(id, req.user)

    const { asset, stream } = result

    res.set('Content-Type', asset.mimetype || 'application/octet-stream')
    res.set('Content-Disposition', `inline; filename="${asset.originalName}"`)

    if (asset.visibility === 'premium' || asset.visibility === 'private') {
      res.set('Cache-Control', 'private, no-store')
    } else {
      res.set('Cache-Control', 'no-store')
    }

    stream.on('error', (err) => {
      console.error('Error en streamFileAssetById:', err)

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Error al leer archivo'
        })
      }
    })

    return stream.pipe(res)
  } catch (err) {
    console.error('Error en streamFileAssetById:', err)

    return res.status(404).json({
      success: false,
      error: err.message || 'Archivo no encontrado'
    })
  }
}

export const deleteFileAsset = async (req, res) => {
  try {
    const { id } = req.params

    const result = await FileAssetService.deleteAsset(id)

    return res.status(200).json(result)
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Error eliminando archivo'
    })
  }
}

export const getFilesByEntity = async (req, res) => {
  try {
    const { module, entityType, entityId } = req.params

    const result = await FileAssetService.getFilesByEntity({
      module,
      entityType,
      entityId
    })

    return res.status(200).json(result)
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Error obteniendo archivos'
    })
  }
}

export const listFileAssets = async (req, res) => {
  try {
    const { module, visibility, page, limit } = req.query

    const result = await FileAssetService.listFiles({
      module,
      visibility,
      page,
      limit
    })

    return res.status(200).json(result)
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Error listando archivos'
    })
  }
}

export const downloadActiveCatalog = async (req, res) => {
  try {
    const result = await FileAssetService.getActiveCatalogStream(req.user)

    const { asset, stream } = result

    res.set('Content-Disposition', `attachment; filename="${asset.originalName}"`)

    res.set('Content-Type', asset.mimetype || 'application/pdf')

    stream.pipe(res)
  } catch (err) {
    return res.status(404).json({
      success: false,
      error: err.message
    })
  }
}
