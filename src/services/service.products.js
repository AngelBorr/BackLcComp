// services/service.products.js
import mongoose from 'mongoose'
import productModel from '../dao/models/produtc.model.js'
import logger from '../utils/logger.js'
import FileService from './service.files.js' // ✅ tu service GridFS (ya existe)

class ServiceError extends Error {
  constructor(message, code = 'SERVICE_ERROR', status = 500, details = undefined) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''))
const toObjectIdOrNull = (id) => (isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null)

const pick = (obj, keys) => {
  const out = {}
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k]
  return out
}

const normalizeString = (v) => (v === undefined ? undefined : String(v).trim())

/**
 * ✅ Normaliza imágenes para prodImgs[]
 * Acepta:
 * - payload.prodImgs: [{fileId},{...}] o [id,id]
 * - payload.images: [id,id]
 * - payload.prodImg1..4: id
 *
 * Devuelve:
 * - null si NO vino nada relacionado a imágenes (para no pisar en update)
 * - array de ObjectId válidos si vino algo (puede ser [])
 */
const extractImageIds = (payload) => {
  const rawProdImgs = payload?.prodImgs
  const rawImages = payload?.images

  // Caso 1: prodImgs viene como array
  if (Array.isArray(rawProdImgs)) {
    const ids = rawProdImgs
      .map((x) => (x && typeof x === 'object' ? x.fileId ?? x._id ?? x.id : x))
      .map((x) => toObjectIdOrNull(x))
      .filter(Boolean)
    return ids
  }

  // Caso 2: images viene como array
  if (Array.isArray(rawImages)) {
    const ids = rawImages.map((x) => toObjectIdOrNull(x)).filter(Boolean)
    return ids
  }

  // Caso 3: prodImg1..4 legacy
  const legacy = [payload?.prodImg1, payload?.prodImg2, payload?.prodImg3, payload?.prodImg4]
  const hasAnyLegacy = legacy.some((x) => x !== undefined)
  if (hasAnyLegacy) {
    const ids = legacy.map((x) => toObjectIdOrNull(x)).filter(Boolean)
    return ids
  }

  // Nada de imágenes vino en el payload
  return null
}

class ProductsService {
  #assertValidObjectId(id) {
    if (!id) throw new ServiceError('ID requerido', 'MISSING_ID', 400)
    if (!mongoose.Types.ObjectId.isValid(id))
      throw new ServiceError('ID inválido', 'INVALID_ID', 400)
  }

  async getProducts() {
    try {
      logger.debug('[ProductsService] getProducts')
      const products = await productModel.find({ isActive: true }).sort({ createdAt: -1 }).lean()
      return Array.isArray(products) ? products : []
    } catch (err) {
      logger.error(`[ProductsService] getProducts error: ${err?.message || err}`)
      throw new ServiceError('Error al obtener productos', 'GET_PRODUCTS_FAILED', 500, {
        cause: err?.message
      })
    }
  }

  async getProductById(id) {
    try {
      logger.debug(`[ProductsService] getProductById id=${id}`)
      this.#assertValidObjectId(id)

      const product = await productModel.findById(id).lean()
      if (!product) throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)

      return product
    } catch (err) {
      if (err instanceof ServiceError) throw err
      logger.error(`[ProductsService] getProductById error: ${err?.message || err}`)
      throw new ServiceError('Error al obtener producto', 'GET_PRODUCT_FAILED', 500, {
        cause: err?.message
      })
    }
  }

  /**
   * Convierte fileIds → objetos prodImgs con metadata de GridFS.
   * Si algún fileId no existe, tira ServiceError(404).
   */
  async #buildProdImgsFromFileIds(fileIds) {
    // max 4 (igual lo valida el schema, pero mejor fallar acá con mensaje claro)
    if (fileIds.length > 4) {
      throw new ServiceError('Máximo 4 imágenes por producto', 'MAX_IMAGES_EXCEEDED', 400)
    }

    const unique = []
    const seen = new Set()
    for (const oid of fileIds) {
      const key = String(oid)
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(oid)
      }
    }

    // Traemos metadata desde GridFS para guardar en prodImgs
    const infos = await Promise.all(
      unique.map(async (oid) => {
        const fileIdStr = String(oid)

        const exists = await FileService.fileExists(fileIdStr)
        if (!exists?.success || !exists?.exists) {
          throw new ServiceError('Imagen no existe en GridFS', 'IMAGE_NOT_FOUND', 404, {
            fileId: fileIdStr
          })
        }

        // getFileById ya lo tenés: devuelve fileInfo (id, filename, length, uploadDate, contentType)
        const got = await FileService.getFileById(fileIdStr)
        if (!got?.success || !got?.fileInfo) {
          throw new ServiceError(
            'No se pudo obtener metadata de la imagen',
            'IMAGE_META_FAILED',
            500,
            {
              fileId: fileIdStr
            }
          )
        }

        const f = got.fileInfo
        return {
          fileId: oid,
          filename: f.filename || '',
          contentType: f.contentType || '',
          length: Number(f.length || 0),
          uploadDate: f.uploadDate ? new Date(f.uploadDate) : undefined,
          isCover: false
        }
      })
    )

    // Por defecto: primera imagen es cover si hay imágenes
    if (infos.length) infos[0].isCover = true

    return infos
  }

  async createProduct(body, files = []) {
    let uploadedFileIds = [] // ✅ para rollback si falla el create

    try {
      logger.debug('[ProductsService] createProduct')

      if (!body || typeof body !== 'object') {
        throw new ServiceError(
          'Datos inválidos para crear producto',
          'INVALID_PRODUCT_PAYLOAD',
          400
        )
      }

      const base = pick(body, [
        'prodName',
        'prodDescription',
        'prodPrecioMinorista',
        'prodPrecioMayorista',
        'prodCategoria',
        'prodMarca',
        'prodProcesador',
        'prodMotherBoard',
        'prodMemoriaRam',
        'prodDiscoInterno',
        'prodGabinete',
        'prodPlacaVideo',
        'prodFuente',
        'prodTecladoMouse',
        'prodStock',
        'isActive'
      ])

      base.prodName = normalizeString(base.prodName)
      base.prodDescription = normalizeString(base.prodDescription) ?? ''
      base.prodCategoria = normalizeString(base.prodCategoria)
      base.prodMarca = normalizeString(base.prodMarca) ?? ''

      if (!base.prodName) throw new ServiceError('prodName es requerido', 'MISSING_PROD_NAME', 400)
      if (!base.prodCategoria)
        throw new ServiceError('prodCategoria es requerido', 'MISSING_PROD_CATEGORIA', 400)

      // precios
      if (base.prodPrecioMinorista === undefined || base.prodPrecioMinorista === null) {
        throw new ServiceError('prodPrecioMinorista es requerido', 'MISSING_PRICE_MINORISTA', 400)
      }
      if (base.prodPrecioMayorista === undefined || base.prodPrecioMayorista === null) {
        throw new ServiceError('prodPrecioMayorista es requerido', 'MISSING_PRICE_MAYORISTA', 400)
      }

      const minorista = Number(base.prodPrecioMinorista)
      const mayorista = Number(base.prodPrecioMayorista)
      if (Number.isNaN(minorista) || minorista < 0)
        throw new ServiceError('prodPrecioMinorista inválido', 'INVALID_PRICE_MINORISTA', 400)
      if (Number.isNaN(mayorista) || mayorista < 0)
        throw new ServiceError('prodPrecioMayorista inválido', 'INVALID_PRICE_MAYORISTA', 400)
      if (mayorista > minorista) {
        throw new ServiceError(
          'El precio mayorista no puede ser mayor al minorista',
          'INVALID_PRICE_RELATION',
          400
        )
      }

      base.prodPrecioMinorista = minorista
      base.prodPrecioMayorista = mayorista

      // ✅ stock
      if (base.prodStock !== undefined && base.prodStock !== null) {
        const s = Number(base.prodStock)
        if (Number.isNaN(s) || s < 0)
          throw new ServiceError('prodStock inválido', 'INVALID_STOCK', 400)
        base.prodStock = s
      }

      // ✅ Imágenes: prioridad a files
      let prodImgs = []

      if (Array.isArray(files) && files.length) {
        if (files.length > 4) {
          throw new ServiceError('Máximo 4 imágenes', 'MAX_IMAGES_EXCEEDED', 400)
        }

        for (const f of files) {
          const isImage = String(f.mimetype || '').startsWith('image/')
          if (!isImage) {
            throw new ServiceError('Solo se permiten imágenes', 'INVALID_IMAGE_TYPE', 400, {
              mimetype: f.mimetype,
              filename: f.originalname
            })
          }

          // 🔥 sube a GridFS
          logger.debug(`[ProductsService] uploading ${f.originalname} (${f.size}) `)

          const uploadResult = await FileService.uploadFile(f.buffer, f.originalname, {
            contentType: f.mimetype
          })

          logger.debug(`[ProductsService] uploaded fileId=${uploadResult?.fileId}`)

          if (!uploadResult?.success || !uploadResult?.fileId) {
            throw new ServiceError('No se pudo subir imagen', 'UPLOAD_IMAGE_FAILED', 500, {
              filename: f.originalname
            })
          }

          uploadedFileIds.push(String(uploadResult.fileId))

          // Construimos el objeto que espera tu schema prodImgs
          prodImgs.push({
            fileId: uploadResult.fileId,
            filename: uploadResult.filename || f.originalname,
            contentType: f.mimetype,
            length: f.size,
            uploadDate: new Date(),
            isCover: false
          })

          if (prodImgs.length) prodImgs[0].isCover = true
        }
      } else {
        // ✅ fallback: aceptar IDs en body (si algún día mandás ids)
        const imageIds = extractImageIds(body)
        prodImgs = Array.isArray(imageIds) ? await this.#buildProdImgsFromFileIds(imageIds) : []
      }

      const created = await productModel.create({
        ...base,
        prodImgs
      })

      logger.info(`[ProductsService] Producto creado id=${created._id}`)
      return created.toObject()
    } catch (err) {
      // ✅ rollback: si subimos imágenes y luego falló el create, las borramos
      if (uploadedFileIds.length) {
        for (const fid of uploadedFileIds) {
          try {
            await FileService.deleteFileById(fid)
          } catch (_) {
            // no frenamos el error original
          }
        }
      }

      if (err instanceof ServiceError) throw err
      logger.error(`[ProductsService] createProduct error: ${err?.message || err}`)
      throw new ServiceError('Error interno al crear producto', 'CREATE_PRODUCT_FAILED', 500, {
        cause: err?.message
      })
    }
  }

  // update  products
  async updateProduct(id, body, files = []) {
    let uploadedFileIds = [] // ✅ rollback si falla update
    let oldFileIdsToDelete = [] // ✅ para limpiar imágenes anteriores si se reemplazan

    try {
      logger.debug(`[ProductsService] updateProduct id=${id}`)
      this.#assertValidObjectId(id)

      if (!body || typeof body !== 'object') {
        throw new ServiceError(
          'Datos inválidos para actualizar producto',
          'INVALID_PRODUCT_PAYLOAD',
          400
        )
      }

      // ✅ buscamos el producto actual (necesario para reglas de precios y para imágenes)
      const current = await productModel.findById(id).lean()
      if (!current) throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)

      const base = pick(body, [
        'prodName',
        'prodDescription',
        'prodPrecioMinorista',
        'prodPrecioMayorista',
        'prodCategoria',
        'prodMarca',
        'prodProcesador',
        'prodMotherBoard',
        'prodMemoriaRam',
        'prodDiscoInterno',
        'prodGabinete',
        'prodPlacaVideo',
        'prodFuente',
        'prodTecladoMouse',
        'prodStock',
        'isActive'
      ])

      // Normalización (solo si vienen)
      if (base.prodName !== undefined) base.prodName = normalizeString(base.prodName)
      if (base.prodDescription !== undefined)
        base.prodDescription = normalizeString(base.prodDescription) ?? ''
      if (base.prodCategoria !== undefined) base.prodCategoria = normalizeString(base.prodCategoria)
      if (base.prodMarca !== undefined) base.prodMarca = normalizeString(base.prodMarca) ?? ''

      // ✅ isActive viene como string en multipart
      if (base.isActive !== undefined) {
        base.isActive = String(base.isActive).toLowerCase() === 'true'
      }

      // ✅ precios/stock (si vienen)
      const incomingMinor =
        base.prodPrecioMinorista !== undefined ? Number(base.prodPrecioMinorista) : undefined
      const incomingMayor =
        base.prodPrecioMayorista !== undefined ? Number(base.prodPrecioMayorista) : undefined

      if (incomingMinor !== undefined && (Number.isNaN(incomingMinor) || incomingMinor < 0)) {
        throw new ServiceError('prodPrecioMinorista inválido', 'INVALID_PRICE_MINORISTA', 400)
      }
      if (incomingMayor !== undefined && (Number.isNaN(incomingMayor) || incomingMayor < 0)) {
        throw new ServiceError('prodPrecioMayorista inválido', 'INVALID_PRICE_MAYORISTA', 400)
      }

      // Validar relación mayorista<=minorista:
      if (incomingMinor !== undefined || incomingMayor !== undefined) {
        const finalMinor =
          incomingMinor !== undefined ? incomingMinor : Number(current.prodPrecioMinorista)
        const finalMayor =
          incomingMayor !== undefined ? incomingMayor : Number(current.prodPrecioMayorista)

        if (finalMayor > finalMinor) {
          throw new ServiceError(
            'El precio mayorista no puede ser mayor al minorista',
            'INVALID_PRICE_RELATION',
            400
          )
        }

        if (incomingMinor !== undefined) base.prodPrecioMinorista = finalMinor
        if (incomingMayor !== undefined) base.prodPrecioMayorista = finalMayor
      }

      // ✅ stock
      if (base.prodStock !== undefined && base.prodStock !== null) {
        const s = Number(base.prodStock)
        if (Number.isNaN(s) || s < 0)
          throw new ServiceError('prodStock inválido', 'INVALID_STOCK', 400)
        base.prodStock = s
      }

      // ✅ Imágenes:
      // - si vienen files => reemplazamos prodImgs
      // - si no vienen files => no tocamos prodImgs (salvo que mandes IDs y extractImageIds no sea null)
      let prodImgsUpdate = undefined

      if (Array.isArray(files) && files.length) {
        if (files.length > 4) {
          throw new ServiceError('Máximo 4 imágenes', 'MAX_IMAGES_EXCEEDED', 400)
        }

        // guardo las viejas para poder borrarlas si todo sale ok
        oldFileIdsToDelete = Array.isArray(current.prodImgs)
          ? current.prodImgs.map((img) => String(img.fileId)).filter(Boolean)
          : []

        const prodImgs = []

        for (const f of files) {
          const isImage = String(f.mimetype || '').startsWith('image/')
          if (!isImage) {
            throw new ServiceError('Solo se permiten imágenes', 'INVALID_IMAGE_TYPE', 400, {
              mimetype: f.mimetype,
              filename: f.originalname
            })
          }

          logger.debug(`[ProductsService] uploading ${f.originalname} (${f.size}) `)

          const uploadResult = await FileService.uploadFile(f.buffer, f.originalname, {
            contentType: f.mimetype
          })

          logger.debug(`[ProductsService] uploaded fileId=${uploadResult?.fileId}`)

          if (!uploadResult?.success || !uploadResult?.fileId) {
            throw new ServiceError('No se pudo subir imagen', 'UPLOAD_IMAGE_FAILED', 500, {
              filename: f.originalname
            })
          }

          uploadedFileIds.push(String(uploadResult.fileId))

          prodImgs.push({
            fileId: uploadResult.fileId,
            filename: uploadResult.filename || f.originalname,
            contentType: f.mimetype,
            length: f.size,
            uploadDate: new Date(),
            isCover: false,
            alt: '' // opcional
          })
        }

        // cover: por defecto la 1ra
        if (prodImgs.length) prodImgs[0].isCover = true

        prodImgsUpdate = prodImgs
      } else {
        // compatibilidad: si mandás IDs en body, actualiza prodImgs
        const imageIds = extractImageIds(body) // si no viene nada => null
        if (imageIds !== null) {
          prodImgsUpdate = await this.#buildProdImgsFromFileIds(imageIds) // puede ser []
        }
      }

      const $set = { ...base }
      if (prodImgsUpdate !== undefined) $set.prodImgs = prodImgsUpdate

      const updated = await productModel
        .findByIdAndUpdate(id, { $set }, { new: true, runValidators: true, context: 'query' })
        .lean()

      if (!updated) throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)

      // ✅ Si se reemplazaron imágenes y todo salió bien => borrar imágenes viejas
      // Si NO querés borrar, comentá este bloque.
      if (prodImgsUpdate !== undefined && oldFileIdsToDelete.length) {
        for (const fid of oldFileIdsToDelete) {
          try {
            await FileService.deleteFileById(fid)
          } catch (_) {
            // no rompemos la actualización por fallas de cleanup
          }
        }
      }

      logger.info(`[ProductsService] Producto actualizado id=${updated._id}`)
      return updated
    } catch (err) {
      // ✅ rollback: si subimos imágenes nuevas y falló update, borramos las nuevas
      if (uploadedFileIds.length) {
        for (const fid of uploadedFileIds) {
          try {
            await FileService.deleteFileById(fid)
          } catch (_) {
            // no frenamos el error original
          }
        }
      }

      if (err instanceof ServiceError) throw err
      logger.error(`[ProductsService] updateProduct error: ${err?.message || err}`)
      throw new ServiceError('Error interno al actualizar producto', 'UPDATE_PRODUCT_FAILED', 500, {
        cause: err?.message
      })
    }
  }

  /**
   * ✅ deleteProduct:
   * - deleteImages=true borra GridFS de prodImgs[*].fileId
   * - soft=true hace isActive=false
   */
  async deleteProduct(id, { deleteImages = false, soft = false } = {}) {
    try {
      logger.debug(`[ProductsService] deleteProduct id=${id}`)
      this.#assertValidObjectId(id)

      const product = await productModel.findById(id).lean()
      if (!product) throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)

      if (deleteImages) {
        const ids = Array.isArray(product.prodImgs)
          ? product.prodImgs.map((i) => i?.fileId).filter(Boolean)
          : []

        for (const fileId of ids) {
          // No rompas el delete si una imagen ya no existe
          try {
            await FileService.deleteFileById(String(fileId))
          } catch (e) {
            logger.warn?.(
              `[ProductsService] deleteProduct warn: no se pudo borrar imagen fileId=${fileId} (${
                e?.message || e
              })`
            )
          }
        }
      }

      if (soft) {
        await productModel.updateOne({ _id: id }, { $set: { isActive: false } })
        return { deleted: true, mode: 'soft' }
      }

      await productModel.deleteOne({ _id: id })
      return { deleted: true, mode: 'hard' }
    } catch (err) {
      if (err instanceof ServiceError) throw err
      logger.error(`[ProductsService] deleteProduct error: ${err?.message || err}`)
      throw new ServiceError('Error interno al eliminar producto', 'DELETE_PRODUCT_FAILED', 500, {
        cause: err?.message
      })
    }
  }
}

export { ServiceError }
export default ProductsService
