// src/routes/recipients.router.js
import MyOwnRouter from './router.js'
import { recipientImportUploader } from '../middlewares/recipientImportUploader.js'

import {
  getAllRecipients,
  getRecipientById,
  createRecipient,
  createRecipientsBulk,
  importRecipients,
  updateRecipient,
  deleteRecipient
} from '../controllers/controller.recipient.js'

export default class RecipientsRouter extends MyOwnRouter {
  init() {
    this.get('/recipients', ['ADMIN'], getAllRecipients)

    this.get('/recipients/:id', ['ADMIN'], getRecipientById)

    this.post('/recipients', ['ADMIN'], createRecipient)

    this.post('/recipients/bulk', ['ADMIN'], createRecipientsBulk)

    this.post(
      '/recipients/import',
      ['ADMIN'],
      recipientImportUploader.single('file'),
      importRecipients
    )

    this.put('/recipients/:id', ['ADMIN'], updateRecipient)

    this.delete('/recipients/:id', ['ADMIN'], deleteRecipient)
  }
}
