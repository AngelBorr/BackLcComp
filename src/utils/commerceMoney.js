const MONEY_SCALE = 100
const MONEY_SCALE_BIGINT = 100n
const VAT_BASIS_POINTS = new Map([
  [0.105, 1050],
  [0.21, 2100]
])

const assertSafeMinorUnits = (minorUnits, fieldName) => {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new Error(`${fieldName} excede la precisión monetaria soportada`)
  }
}

const parseUnsignedDecimal = (value, fieldName) => {
  const decimal = String(value).trim()

  if (!/^\d+(?:\.\d+)?$/.test(decimal)) {
    throw new Error(`${fieldName} debe ser un decimal válido no negativo`)
  }

  const [wholePart, fractionPart = ''] = decimal.split('.')
  const normalizedWhole = wholePart.replace(/^0+(?=\d)/, '')

  return {
    integer: BigInt(`${normalizedWhole}${fractionPart}`),
    scale: fractionPart.length,
    normalized: fractionPart ? `${normalizedWhole}.${fractionPart}` : normalizedWhole
  }
}

const roundHalfUpDivision = (numerator, denominator) => {
  if (denominator <= 0n) throw new Error('El divisor monetario debe ser mayor que cero')

  const quotient = numerator / denominator
  const remainder = numerator % denominator

  return remainder * 2n >= denominator ? quotient + 1n : quotient
}

const toSafeNumber = (value, fieldName) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} excede la precisión monetaria soportada`)
  }

  return Number(value)
}

export const normalizeDecimalString = (value, fieldName = 'amount') =>
  parseUnsignedDecimal(value, fieldName).normalized

export const toMinorUnits = (value, fieldName = 'amount') => {
  const decimal = parseUnsignedDecimal(value, fieldName)
  const denominator = 10n ** BigInt(decimal.scale)
  const minorUnits = toSafeNumber(
    roundHalfUpDivision(decimal.integer * MONEY_SCALE_BIGINT, denominator),
    fieldName
  )
  assertSafeMinorUnits(minorUnits, fieldName)

  return minorUnits
}

export const minorUnitsToDecimalString = (minorUnits) => {
  const normalizedMinorUnits =
    typeof minorUnits === 'bigint'
      ? minorUnits
      : (() => {
          assertSafeMinorUnits(minorUnits, 'minorUnits')
          return BigInt(minorUnits)
        })()

  if (normalizedMinorUnits < 0n) {
    throw new Error('minorUnits debe ser un importe válido no negativo')
  }

  const whole = normalizedMinorUnits / MONEY_SCALE_BIGINT
  const fraction = String(normalizedMinorUnits % MONEY_SCALE_BIGINT).padStart(2, '0')

  return `${whole}.${fraction}`
}

export const calculateUsdLineAmounts = ({ unitPriceUsd, vatRate, quantity }) => {
  const normalizedQuantity = Number(quantity)

  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    throw new Error('quantity debe ser un entero mayor que cero')
  }

  const vatBasisPoints = VAT_BASIS_POINTS.get(Number(vatRate))

  if (!vatBasisPoints) {
    throw new Error('vatRate no es válido')
  }

  const unitPriceUsdCents = toMinorUnits(unitPriceUsd, 'unitPriceUsd')

  if (unitPriceUsdCents <= 0) {
    throw new Error('unitPriceUsd debe ser mayor que cero')
  }

  const totalUsdCents = unitPriceUsdCents * normalizedQuantity

  assertSafeMinorUnits(totalUsdCents, 'totalUsdCents')

  const vatDenominator = BigInt(10000 + vatBasisPoints)
  const netUnitPriceUsdCents = toSafeNumber(
    roundHalfUpDivision(BigInt(unitPriceUsdCents) * 10000n, vatDenominator),
    'netUnitPriceUsdCents'
  )
  const lineNetUsdCents = toSafeNumber(
    roundHalfUpDivision(BigInt(totalUsdCents) * 10000n, vatDenominator),
    'lineNetUsdCents'
  )
  const vatAmountPerUnitUsdCents = unitPriceUsdCents - netUnitPriceUsdCents
  const lineVatUsdCents = totalUsdCents - lineNetUsdCents

  for (const [fieldName, value] of Object.entries({
    netUnitPriceUsdCents,
    vatAmountPerUnitUsdCents,
    lineNetUsdCents,
    lineVatUsdCents,
    totalUsdCents
  })) {
    assertSafeMinorUnits(value, fieldName)
  }

  return {
    unitPriceUsd: minorUnitsToDecimalString(unitPriceUsdCents),
    netUnitPriceUsd: minorUnitsToDecimalString(netUnitPriceUsdCents),
    vatAmountPerUnitUsd: minorUnitsToDecimalString(vatAmountPerUnitUsdCents),
    lineNetUsd: minorUnitsToDecimalString(lineNetUsdCents),
    lineVatUsd: minorUnitsToDecimalString(lineVatUsdCents),
    totalUsd: minorUnitsToDecimalString(totalUsdCents),
    totalUsdCents
  }
}

export const convertUsdToArs = ({ totalUsd, rate }) => {
  const totalUsdCents = BigInt(toMinorUnits(totalUsd, 'totalUsd'))
  const exchangeRate = parseUnsignedDecimal(rate, 'rate')

  if (totalUsdCents <= 0n) throw new Error('totalUsd debe ser mayor que cero')
  if (exchangeRate.integer <= 0n) throw new Error('rate debe ser mayor que cero')

  const denominator = 10n ** BigInt(exchangeRate.scale)
  const totalArsCents = roundHalfUpDivision(
    totalUsdCents * exchangeRate.integer,
    denominator
  )

  return {
    totalUsd: minorUnitsToDecimalString(totalUsdCents),
    rate: exchangeRate.normalized,
    totalArs: minorUnitsToDecimalString(totalArsCents)
  }
}

export { MONEY_SCALE, VAT_BASIS_POINTS }
