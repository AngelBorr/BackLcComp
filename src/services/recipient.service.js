// src/services/recipient.service.js
import RecipientManager from '../dao/managers/recipient.manager.js'
import XLSX from 'xlsx'

class RecipientService {
  constructor() {
    this.recipientManager = new RecipientManager()
  }

  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  normalizeRecipient(data) {
    const email = data.email?.trim().toLowerCase()

    if (!email || !this.isValidEmail(email)) {
      throw new Error('Debe ingresar un email válido')
    }

    return {
      email,
      name: data.name?.trim() || '',
      source: data.source || 'manual',
      status: data.status || 'active',
      tags: Array.isArray(data.tags) ? data.tags : [],
      notes: data.notes?.trim() || ''
    }
  }

  parseCsv(buffer) {
    const content = buffer.toString('utf-8')

    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [email, name = ''] = line.split(',').map((value) => value.trim())

        return {
          email,
          name
        }
      })
  }

  parseXlsx(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false
    })

    return rows.map((row) => ({
      email: row.email || row.Email || row.EMAIL || '',
      name: row.name || row.Name || row.nombre || row.Nombre || ''
    }))
  }

  async importRecipientsFromFile(file) {
    let recipients = []

    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      recipients = this.parseCsv(file.buffer)
    } else {
      recipients = this.parseXlsx(file.buffer)
    }

    recipients = recipients.map((recipient) => ({
      ...recipient,
      source: 'imported',
      status: 'active',
      tags: ['importacion-archivo'],
      notes: `Importado desde archivo: ${file.originalname}`
    }))

    return this.createRecipientsBulk(recipients)
  }

  async getAllRecipients(filters) {
    return this.recipientManager.getAll(filters)
  }

  async getRecipientById(id) {
    const recipient = await this.recipientManager.getById(id)

    if (!recipient) {
      throw new Error('Destinatario no encontrado')
    }

    return recipient
  }

  async createRecipient(data) {
    const normalized = this.normalizeRecipient(data)

    const existing = await this.recipientManager.getByEmail(normalized.email)

    if (existing) {
      throw new Error('Ya existe un destinatario con ese email')
    }

    return this.recipientManager.create(normalized)
  }

  async createRecipientsBulk(recipients = []) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('Debe enviar un array de destinatarios')
    }

    const validRecipients = []
    const rejected = []
    const seenEmails = new Set()

    for (const recipient of recipients) {
      try {
        const normalized = this.normalizeRecipient({
          ...recipient,
          source: recipient.source || 'imported'
        })

        if (seenEmails.has(normalized.email)) {
          rejected.push({
            email: normalized.email,
            reason: 'Email duplicado en la carga'
          })
          continue
        }

        const existing = await this.recipientManager.getByEmail(normalized.email)

        if (existing) {
          rejected.push({
            email: normalized.email,
            reason: 'Ya existe en la base'
          })
          continue
        }

        seenEmails.add(normalized.email)
        validRecipients.push(normalized)
      } catch (err) {
        rejected.push({
          email: recipient.email || null,
          reason: err.message
        })
      }
    }

    let created = []

    if (validRecipients.length > 0) {
      created = await this.recipientManager.bulkCreate(validRecipients)
    }

    return {
      created,
      rejected,
      summary: {
        received: recipients.length,
        created: created.length,
        rejected: rejected.length
      }
    }
  }

  async updateRecipient(id, data) {
    const updateData = {}

    if (data.email !== undefined) {
      const email = data.email.trim().toLowerCase()

      if (!this.isValidEmail(email)) {
        throw new Error('Debe ingresar un email válido')
      }

      const existing = await this.recipientManager.getByEmail(email)

      if (existing && existing._id.toString() !== id) {
        throw new Error('Ya existe otro destinatario con ese email')
      }

      updateData.email = email
    }

    if (data.name !== undefined) updateData.name = data.name.trim()
    if (data.source !== undefined) updateData.source = data.source
    if (data.status !== undefined) updateData.status = data.status
    if (data.tags !== undefined) updateData.tags = Array.isArray(data.tags) ? data.tags : []
    if (data.notes !== undefined) updateData.notes = data.notes.trim()

    const updated = await this.recipientManager.update(id, updateData)

    if (!updated) {
      throw new Error('Destinatario no encontrado')
    }

    return updated
  }

  async deleteRecipient(id) {
    const deleted = await this.recipientManager.softDelete(id)

    if (!deleted) {
      throw new Error('Destinatario no encontrado')
    }

    return deleted
  }
}

export default RecipientService
