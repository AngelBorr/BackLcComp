import multer from 'multer'

export const htmlTemplateUploader = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 1,
    fileSize: 2 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const originalName = file.originalname.toLowerCase()

    const isHtml =
      file.mimetype === 'text/html' ||
      originalName.endsWith('.html') ||
      originalName.endsWith('.htm')

    if (!isHtml) {
      return cb(new Error('Solo se permiten archivos HTML'))
    }

    cb(null, true)
  }
})
