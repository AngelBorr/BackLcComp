import MyOwnRouter from './router.js'

import {
  uploadFileAsset,
  uploadCatalogPdf,
  getActiveCatalog,
  streamActiveCatalog,
  getFileAssetById,
  streamFileAssetById,
  deleteFileAsset,
  getFilesByEntity,
  listFileAssets,
  downloadActiveCatalog
} from '../controllers/controller.fileAsset.js'

import fileAssetUploader from '../middlewares/fileAssetUploader.js'

export default class FileAssetsRouter extends MyOwnRouter {
  init() {
    this.get('/catalog/active', ['PREMIUM', 'ADMIN'], getActiveCatalog)

    this.get('/catalog/pdf', ['PREMIUM', 'ADMIN'], streamActiveCatalog)

    this.get('/catalog/download', ['PREMIUM', 'ADMIN'], downloadActiveCatalog)

    this.post('/catalog/upload', ['ADMIN'], fileAssetUploader.single('file'), uploadCatalogPdf)

    this.get('/', ['ADMIN'], listFileAssets)

    this.post('/upload', ['ADMIN'], fileAssetUploader.single('file'), uploadFileAsset)

    this.get('/entity/:module/:entityType/:entityId', ['ADMIN'], getFilesByEntity)

    this.get('/view/:id', ['ADMIN'], streamFileAssetById)

    this.get('/:id', ['ADMIN'], getFileAssetById)

    this.delete('/:id', ['ADMIN'], deleteFileAsset)
  }
}
