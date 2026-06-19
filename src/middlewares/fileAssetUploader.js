import multer from 'multer'

const storage = multer.memoryStorage()

const allowedMimeTypes = [
  // PDF
  'application/pdf',

  // Images
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',

  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // Text / CSV
  'text/plain',
  'text/csv'
]

const fileFilter = (req, file, cb) => {
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`), false)
  }

  cb(null, true)
}

const fileAssetUploader = multer({
  storage,
  fileFilter,
  limits: {
    files: 5,
    fileSize: 20 * 1024 * 1024 // 20MB
  }
})

export default fileAssetUploader
