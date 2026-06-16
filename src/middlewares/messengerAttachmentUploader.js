// src/middlewares/messengerAttachmentUploader.js
import multer from 'multer'

export const messengerAttachmentUploader = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 5,
    fileSize: 15 * 1024 * 1024 // 15MB por archivo
  },

  fileFilter: (req, file, cb) => {
    // Acepta cualquier tipo de archivo, pero no archivos sin nombre
    if (!file.originalname) {
      return cb(new Error('Archivo inválido'))
    }

    cb(null, true)
  }
})
