import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// import nodemailer from 'nodemailer'
// import swaggerJsdoc from 'swagger-jsdoc'
// import path from 'path';
import multer from 'multer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Exporta dos paths diferentes
export const utilsDirname = __dirname // Para archivos en utils
export const srcDirname = join(__dirname, '..') // Para llegar a src/

export default srcDirname // Exporta src/ por defecto

// config nodemailer
/* export const generateTokenForEmail = (email) => {
    const token = jwt.sign({email}, `${PRIVATE_KEY}`, {expiresIn: '1h'})
    return token
}

const mailConfig = {
    service: env.mailingService,
    port: env.mailingPort,
    auth: {
        user: env.mailingUser,
        pass: env.mailingPass,
    },
    tls: {
        rejectUnauthorized: false
    }
}

export const transport = nodemailer.createTransport(mailConfig);

//configuracion swagger
const swaggerOptions ={
    definition:{
        openapi: '3.0.1',
        info: {
            title: 'Documentacion del poder y del saber',
            description: 'API pensada para clase de Swagger'
        }
    },
    apis:[`${__dirname}/docs/* /*.yaml`]
}

export const specs = swaggerJsdoc(swaggerOptions)

//configuracion multer
const storage = multer.diskStorage({
    destination:function(req,file,cb){
        switch (file.fieldname) {
            case 'documents':
                cb(null, path.join(`${__dirname}/dao/uploads/documents`))
                break;
            case 'profiles':
                cb(null, path.join(`${__dirname}/dao/uploads/profiles`))
                break;
            case 'products':
                cb(null, path.join(`${__dirname}/dao/uploads/products`))
                break;
            default:
                cb(null, path.join(`${__dirname}/dao/uploads/other`))
                break;
        }
    },
    filename:function(req,file,cb){
        cb(null,`${Date.now()}-${file.originalname}`)
    }
})

export const uploader = multer({storage,onError:function(err,next){
    console.log(err);
    next();
}}) */

// ↓↓↓ CONFIGURACIÓN MULTER SIMPLIFICADA ↓↓↓
export const uploader = multer({
  storage: multer.memoryStorage(), // Solo en memoria
  limits: {
    files: 4, // Máx 4 archivos
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/
    const extname = allowedTypes.test(file.originalname.toLowerCase())
    const mimetype = allowedTypes.test(file.mimetype)

    if (mimetype && extname) {
      cb(null, true)
    } else {
      cb(new Error('Tipo de archivo no permitido'))
    }
  }
})
/* export const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { files: 4, fileSize: 10 * 1024 * 1024 }, // 10MB c/u (ajustá)
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) return cb(new Error('Solo imágenes'))
    cb(null, true)
  }
}) */
