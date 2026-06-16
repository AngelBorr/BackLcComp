import MessageTemplateManager from '../dao/managers/messageTemplate.mongo.js'

class MessagesService {
  constructor() {
    this.templateManager = new MessageTemplateManager()
  }

  stripHtml(html = '') {
    return String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  sanitizeHtml(html = '') {
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[\s\S]*?<\/embed>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
      .replace(/\son\w+='[^']*'/gi, '')
      .replace(/javascript:/gi, '')
  }

  extractVariables(html = '') {
    const matches = String(html).match(/{{\s*[\w.]+\s*}}/g) || []

    return [...new Set(matches.map((item) => item.replace('{{', '').replace('}}', '').trim()))]
  }

  normalizeTags(tags) {
    if (!tags) return []

    if (typeof tags === 'string') {
      try {
        const parsed = JSON.parse(tags)

        if (Array.isArray(parsed)) {
          return parsed.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
        }
      } catch {
        return tags
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean)
      }
    }

    if (!Array.isArray(tags)) return []

    return tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
  }

  validateTemplateData({ name, subject, htmlContent, plainTextContent, status }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Debe indicar un nombre para la plantilla')
    }

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new Error('Debe indicar un asunto válido')
    }

    if (!htmlContent || typeof htmlContent !== 'string' || !htmlContent.trim()) {
      throw new Error('Debe indicar contenido HTML')
    }

    if (!plainTextContent || typeof plainTextContent !== 'string' || !plainTextContent.trim()) {
      throw new Error('Debe indicar contenido de texto plano')
    }

    if (status && !['draft', 'ready', 'archived'].includes(status)) {
      throw new Error('Estado de plantilla inválido')
    }
  }

  buildTemplatePayload(data, userId, isUpdate = false) {
    const htmlContent =
      data.htmlContent !== undefined ? this.sanitizeHtml(data.htmlContent) : undefined

    const plainTextContent =
      data.plainTextContent !== undefined
        ? String(data.plainTextContent).trim()
        : htmlContent
          ? this.stripHtml(htmlContent)
          : undefined

    const payload = {
      ...(data.name !== undefined && { name: String(data.name).trim() }),
      ...(data.subject !== undefined && { subject: String(data.subject).trim() }),
      ...(htmlContent !== undefined && { htmlContent }),
      ...(plainTextContent !== undefined && { plainTextContent }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.category !== undefined && {
        category: String(data.category).trim()
      }),
      ...(data.tags !== undefined && {
        tags: this.normalizeTags(data.tags)
      }),
      ...(htmlContent !== undefined && {
        variables: this.extractVariables(htmlContent)
      }),
      ...(userId && (isUpdate ? { updatedBy: userId } : { createdBy: userId }))
    }

    return payload
  }

  async createTemplate(data, userId) {
    const payload = this.buildTemplatePayload(data, userId, false)

    this.validateTemplateData(payload)

    return await this.templateManager.createTemplate(payload)
  }

  async importHtmlTemplate({ file, body, userId }) {
    if (!file) {
      throw new Error('Debe adjuntar un archivo HTML')
    }

    const htmlContent = file.buffer.toString('utf-8')

    const payload = this.buildTemplatePayload(
      {
        name: body.name || file.originalname.replace(/\.(html|htm)$/i, ''),
        subject: body.subject,
        htmlContent,
        plainTextContent: body.plainTextContent || this.stripHtml(htmlContent),
        status: body.status || 'draft',
        category: body.category || '',
        tags: body.tags || []
      },
      userId,
      false
    )

    this.validateTemplateData(payload)

    return await this.templateManager.createTemplate(payload)
  }

  async getTemplates(params) {
    return await this.templateManager.getTemplates(params)
  }

  async getTemplateById(id) {
    const template = await this.templateManager.getTemplateById(id)

    if (!template) {
      throw new Error('Plantilla no encontrada')
    }

    return template
  }

  async updateTemplate(id, data, userId) {
    const currentTemplate = await this.getTemplateById(id)

    const payload = this.buildTemplatePayload(data, userId, true)

    const nextData = {
      ...currentTemplate,
      ...payload
    }

    this.validateTemplateData(nextData)

    return await this.templateManager.updateTemplate(id, payload)
  }

  async deleteTemplate(id) {
    const deleted = await this.templateManager.deleteTemplate(id)

    if (!deleted) {
      throw new Error('Plantilla no encontrada')
    }

    return deleted
  }
}

export default MessagesService
