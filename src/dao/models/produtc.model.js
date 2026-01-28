// models/product.model.js
import mongoose from 'mongoose'

const productCollection = 'products'

// -------------------------
// Subschema: GridFS image
// -------------------------
const gridFsImageSchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    filename: {
      type: String,
      trim: true,
      default: ''
    },
    contentType: {
      type: String,
      trim: true,
      default: ''
    },
    length: {
      type: Number,
      min: 0,
      default: 0
    },
    uploadDate: {
      type: Date
    },
    isCover: {
      type: Boolean,
      default: false
    },
    alt: {
      type: String,
      trim: true,
      maxlength: 140,
      default: ''
    }
  },
  { _id: false }
)

// -------------------------
// Schema principal
// -------------------------
const productSchema = new mongoose.Schema(
  {
    // Datos principales
    prodName: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 140
    },

    prodDescription: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: ''
    },

    // Imágenes (GridFS)
    prodImgs: {
      type: [gridFsImageSchema],
      default: [],
      validate: {
        validator: function (arr) {
          return Array.isArray(arr) && arr.length <= 4
        },
        message: 'Se permite un máximo de 4 imágenes por producto.'
      }
    },

    // Precios
    prodPrecioMinorista: {
      type: Number,
      required: true,
      min: 0
    },
    prodPrecioMayorista: {
      type: Number,
      required: true,
      min: 0
    },

    // Catálogo
    prodCategoria: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80
    },
    prodMarca: {
      type: String,
      trim: true,
      maxlength: 80,
      default: ''
    },

    // Specs
    prodProcesador: { type: String, trim: true, default: '' },
    prodMotherBoard: { type: String, trim: true, default: '' },
    prodMemoriaRam: { type: String, trim: true, default: '' },
    prodDiscoInterno: { type: String, trim: true, default: '' },
    prodGabinete: { type: String, trim: true, default: '' },
    prodPlacaVideo: { type: String, trim: true, default: '' },
    prodFuente: { type: String, trim: true, default: '' },
    prodTecladoMouse: { type: String, trim: true, default: '' },

    // ⭐ Flags de marketing / home
    prodDestacado: {
      type: Boolean,
      default: false
    },
    prodNovedad: {
      type: Boolean,
      default: false
    },

    // Stock / estado
    prodStock: {
      type: Number,
      default: 0,
      min: 0
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
)

// -------------------------
// Índices útiles
// -------------------------
productSchema.index({ prodName: 1 })
productSchema.index({ prodCategoria: 1 })
productSchema.index({ prodMarca: 1 })
productSchema.index({ isActive: 1 })
productSchema.index({ prodDestacado: 1 }) // 🔥 útil para sliders
productSchema.index({ prodNovedad: 1 }) // 🔥 útil para sliders
productSchema.index({ createdAt: -1 })

const productModel = mongoose.model(productCollection, productSchema)
export default productModel
