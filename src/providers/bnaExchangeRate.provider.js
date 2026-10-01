const BNA_SOURCE_URL = 'https://www.bna.com.ar/Personas'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_RESPONSE_BYTES = 1024 * 1024

const SAFE_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú'
})

export class BnaExchangeRateProviderError extends Error {
  constructor(message, code, status = 502) {
    super(message)
    this.name = 'BnaExchangeRateProviderError'
    this.code = code
    this.status = status
  }
}

const failParse = (message) => {
  throw new BnaExchangeRateProviderError(message, 'BNA_QUOTE_PARSE_ERROR', 502)
}

const decodeHtml = (value) =>
  String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const hexadecimal = body[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
    }

    return SAFE_ENTITIES[body] ?? SAFE_ENTITIES[body.toLowerCase()] ?? entity
  })

const htmlToText = (value) =>
  decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

const canonicalText = (value) =>
  htmlToText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const extractUniqueElementById = (html, id) => {
  const escapedId = escapeRegExp(id)
  const openingPattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*(["'])${escapedId}\\2[^>]*>`,
    'gi'
  )
  const matches = [...html.matchAll(openingPattern)]

  if (matches.length !== 1) failParse(`No se pudo identificar inequívocamente la sección ${id}`)

  const opening = matches[0]
  const tagName = opening[1]
  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi')
  tagPattern.lastIndex = opening.index
  let depth = 0
  let tag

  while ((tag = tagPattern.exec(html))) {
    const isClosing = /^<\//.test(tag[0])
    const isSelfClosing = /\/>$/.test(tag[0])

    if (isClosing) depth -= 1
    else if (!isSelfClosing) depth += 1

    if (depth === 0) return html.slice(opening.index, tagPattern.lastIndex)
  }

  failParse(`La sección ${id} no tiene una estructura HTML cerrada`)
}

const extractUniqueBlock = (html, tagName, predicate, description) => {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, 'gi')
  const matches = [...html.matchAll(pattern)].filter((match) => predicate(match[1], match[2]))

  if (matches.length !== 1) failParse(`No se pudo identificar inequívocamente ${description}`)
  return matches[0][0]
}

const extractCells = (row) =>
  [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => htmlToText(match[1]))

const parseArgentineDecimal = (value) => {
  const decimal = String(value).trim()

  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/.test(decimal)) {
    throw new BnaExchangeRateProviderError(
      'BNA devolvió una cotización con formato inválido',
      'BNA_QUOTE_INVALID',
      502
    )
  }

  const [wholePart, fractionPart = ''] = decimal.split(',')
  const normalizedWhole = wholePart.replace(/\./g, '').replace(/^0+(?=\d)/, '')
  const normalized = fractionPart ? `${normalizedWhole}.${fractionPart}` : normalizedWhole

  if (BigInt(`${normalizedWhole}${fractionPart}`) <= 0n) {
    throw new BnaExchangeRateProviderError(
      'BNA devolvió una cotización no positiva',
      'BNA_QUOTE_INVALID',
      502
    )
  }

  return normalized
}

const parseSourceDate = (value) => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim())
  if (!match) failParse('La fecha de la Cotización Billetes no es válida')

  const [, dayText, monthText, yearText] = match
  const day = Number(dayText)
  const month = Number(monthText)
  const year = Number(yearText)
  const candidate = new Date(Date.UTC(year, month - 1, day))

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    failParse('La fecha de la Cotización Billetes no es válida')
  }

  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`
}

const assertOfficialBnaUrl = (url) => {
  let parsed

  try {
    parsed = new URL(url)
  } catch {
    throw new BnaExchangeRateProviderError(
      'La fuente configurada de BNA no es válida',
      'BNA_QUOTE_UNAVAILABLE',
      503
    )
  }

  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (hostname !== 'bna.com.ar' && !hostname.endsWith('.bna.com.ar'))) {
    throw new BnaExchangeRateProviderError(
      'La respuesta de cotización no pertenece a BNA',
      'BNA_QUOTE_UNAVAILABLE',
      503
    )
  }
}

export const parseBnaBilleteSellingQuote = (
  html,
  { fetchedAt = new Date(), sourceUrl = BNA_SOURCE_URL } = {}
) => {
  if (typeof html !== 'string' || !html.trim()) failParse('BNA devolvió una respuesta vacía')

  assertOfficialBnaUrl(sourceUrl)

  const billetesSection = extractUniqueElementById(html, 'billetes')
  const table = extractUniqueBlock(
    billetesSection,
    'table',
    (attributes) => /\bclass\s*=\s*(["'])[^"']*\bcotizacion\b[^"']*\1/i.test(attributes),
    'la tabla de Cotización Billetes'
  )
  const header = extractUniqueBlock(table, 'thead', () => true, 'el encabezado de Cotización Billetes')
  const body = extractUniqueBlock(table, 'tbody', () => true, 'el cuerpo de Cotización Billetes')
  const headerRows = [...header.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]

  if (headerRows.length !== 1) failParse('El encabezado de Cotización Billetes es ambiguo')

  const headerCells = extractCells(headerRows[0][1])
  const compraIndexes = headerCells
    .map((cell, index) => (canonicalText(cell) === 'compra' ? index : -1))
    .filter((index) => index >= 0)
  const ventaIndexes = headerCells
    .map((cell, index) => (canonicalText(cell) === 'venta' ? index : -1))
    .filter((index) => index >= 0)

  if (compraIndexes.length !== 1 || ventaIndexes.length !== 1) {
    failParse('La tabla de Cotización Billetes no distingue Compra y Venta')
  }

  const compraIndex = compraIndexes[0]
  const ventaIndex = ventaIndexes[0]
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    extractCells(match[1])
  )
  const usdRows = rows.filter((cells) => canonicalText(cells[0]) === 'dolar u.s.a')

  if (usdRows.length !== 1) failParse('No se encontró un único Dolar U.S.A en Cotización Billetes')
  if (ventaIndex <= compraIndex || !usdRows[0][ventaIndex]) {
    failParse('No se encontró la cotización Venta de Dolar U.S.A')
  }

  const sourceDate = parseSourceDate(headerCells[0])
  const timeMatches = [
    ...billetesSection.matchAll(/Hora\s+Actualizaci[oó]n\s*:\s*(\d{2}:\d{2})/gi)
  ]

  if (timeMatches.length !== 1 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeMatches[0][1])) {
    failParse('La hora de actualización de Cotización Billetes es ambigua')
  }

  const sourceUpdatedTime = timeMatches[0][1]
  const normalizedFetchedAt = new Date(fetchedAt)

  if (Number.isNaN(normalizedFetchedAt.getTime())) {
    throw new BnaExchangeRateProviderError(
      'La fecha de obtención de la cotización no es válida',
      'BNA_QUOTE_INVALID',
      502
    )
  }

  return {
    source: 'BNA',
    quoteType: 'billete_venta',
    baseCurrency: 'USD',
    quoteCurrency: 'ARS',
    rate: parseArgentineDecimal(usdRows[0][ventaIndex]),
    sourceDate,
    sourceUpdatedTime,
    sourceEffectiveAt: new Date(`${sourceDate}T${sourceUpdatedTime}:00-03:00`).toISOString(),
    fetchedAt: normalizedFetchedAt.toISOString(),
    sourceUrl
  }
}

class BnaExchangeRateProvider {
  constructor({ fetchImplementation = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImplementation !== 'function') {
      throw new Error('fetch no está disponible para consultar BNA')
    }

    this.fetch = fetchImplementation
    this.timeoutMs = timeoutMs
  }

  async getUsdArsSellingQuote({ now = new Date() } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetch(BNA_SOURCE_URL, {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: controller.signal
      })

      if (!response?.ok) {
        throw new BnaExchangeRateProviderError(
          'BNA no devolvió una respuesta exitosa',
          'BNA_QUOTE_UNAVAILABLE',
          503
        )
      }

      if (response.url) assertOfficialBnaUrl(response.url)

      const contentType = response.headers?.get?.('content-type') || ''
      if (!/^text\/html\b/i.test(contentType)) {
        throw new BnaExchangeRateProviderError(
          'BNA devolvió un tipo de contenido inesperado',
          'BNA_QUOTE_UNAVAILABLE',
          503
        )
      }

      const declaredLength = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new BnaExchangeRateProviderError(
          'La respuesta de BNA excede el tamaño permitido',
          'BNA_QUOTE_UNAVAILABLE',
          503
        )
      }

      const html = await response.text()
      if (Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new BnaExchangeRateProviderError(
          'La respuesta de BNA excede el tamaño permitido',
          'BNA_QUOTE_UNAVAILABLE',
          503
        )
      }

      return parseBnaBilleteSellingQuote(html, {
        fetchedAt: now,
        sourceUrl: response.url || BNA_SOURCE_URL
      })
    } catch (error) {
      if (error instanceof BnaExchangeRateProviderError) throw error

      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new BnaExchangeRateProviderError(
          'La consulta a BNA superó el tiempo de espera',
          'BNA_QUOTE_TIMEOUT',
          503
        )
      }

      throw new BnaExchangeRateProviderError(
        'No se pudo obtener la cotización oficial de BNA',
        'BNA_QUOTE_UNAVAILABLE',
        503
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}

export { BNA_SOURCE_URL, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, parseArgentineDecimal }
export default new BnaExchangeRateProvider()
export { BnaExchangeRateProvider }
