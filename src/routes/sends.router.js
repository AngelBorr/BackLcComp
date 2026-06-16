// src/routes/sends.router.js
import MyOwnRouter from './router.js'

import { messengerAttachmentUploader } from '../middlewares/messengerAttachmentUploader.js'
import {
  getSendById,
  getSends,
  retryFailedRecipients,
  sendMessengerEmail
} from '../controllers/controller.send.js'

// src/routes/emailLogs.router.js
export default class SendsRouter extends MyOwnRouter {
  init() {
    this.get('/sends', ['ADMIN'], getSends)

    this.get('/sends/:id', ['ADMIN'], getSendById)

    this.post(
      '/sends',
      ['ADMIN'],
      messengerAttachmentUploader.array('attachments', 5),
      sendMessengerEmail
    )

    this.post('/sends/:id/retry-failed', ['ADMIN'], retryFailedRecipients)
  }
}
