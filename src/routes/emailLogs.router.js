import MyOwnRouter from './router.js'
import {
  getAllEmailLogs,
  getEmailLogById,
  getEmailLogsByEmail,
  getEmailLogsBySendId
} from '../controllers/controller.emailLog.js'

export default class EmailLogsRouter extends MyOwnRouter {
  init() {
    this.get('/email-logs', ['ADMIN'], getAllEmailLogs)

    this.get('/email-logs/detail/:id', ['ADMIN'], getEmailLogById)

    this.get('/email-logs/send/:sendId', ['ADMIN'], getEmailLogsBySendId)

    this.get('/email-logs/:email', ['ADMIN'], getEmailLogsByEmail)
  }
}
