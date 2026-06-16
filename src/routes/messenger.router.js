// src/routes/messenger.router.js
import MyOwnRouter from './router.js'
import RecipientsRouter from './recipients.router.js'
import EmailLogsRouter from './emailLogs.router.js'
import SendsRouter from './sends.router.js'
import MessagesRouter from './messages.router.js'

export default class MessengerRouter extends MyOwnRouter {
  init() {
    const recipientsRouter = new RecipientsRouter()
    const emailLogsRouter = new EmailLogsRouter()
    const sendsRouter = new SendsRouter()
    const messagesRouter = new MessagesRouter()

    this.router.use('/', recipientsRouter.getRouter())
    this.router.use('/', emailLogsRouter.getRouter())
    this.router.use('/', sendsRouter.getRouter())
    this.router.use('/', messagesRouter.getRouter())
  }
}
