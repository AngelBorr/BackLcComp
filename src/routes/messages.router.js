import MyOwnRouter from './router.js'
import { htmlTemplateUploader } from '../middlewares/htmlTemplateUploader.js'
import {
  createMessage,
  importHtmlMessage,
  getMessages,
  getMessageById,
  updateMessage,
  deleteMessage
} from '../controllers/controller.messages.js'

export default class MessagesRouter extends MyOwnRouter {
  init() {
    this.get('/messages', ['ADMIN'], getMessages)

    this.get('/messages/:id', ['ADMIN'], getMessageById)

    this.post('/messages', ['ADMIN'], createMessage)

    this.post('/messages/import', ['ADMIN'], htmlTemplateUploader.single('file'), importHtmlMessage)

    this.put('/messages/:id', ['ADMIN'], updateMessage)

    this.delete('/messages/:id', ['ADMIN'], deleteMessage)
  }
}
