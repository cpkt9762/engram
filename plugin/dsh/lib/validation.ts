export interface Schema {
  type: string
  properties?: Record<string, Schema>
  required?: readonly string[]
  items?: Schema
  enum?: readonly string[]
  minimum?: number
  maximum?: number
  minLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}
function violations(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type === 'integer' ? !Number.isSafeInteger(value) : type !== schema.type) {
    errors.push(`${path || 'arguments'} must be ${schema.type}`); return
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) errors.push(`${path} is outside the supported range`)
  if (schema.enum && !schema.enum.includes(value as string)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`)
  // Optional-string omission is handled separately before validation; required
  // text and declared minLength constraints still apply here.
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`)
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) errors.push(`${path} has an unsupported number of items`)
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path} must contain unique items`)
    if (schema.items) value.forEach((item, i) => violations(schema.items!, item, `${path}[${i}]`, errors))
  }
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>, fields = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key) || object[key] === undefined) errors.push(`${path ? path + '.' : ''}${key} is required`)
      else if (typeof object[key] === 'string' && !object[key].trim()) errors.push(`${path ? path + '.' : ''}${key} must not be blank`)
    }
    for (const [key, item] of Object.entries(object)) {
      const next = path ? `${path}.${key}` : key
      if (!Object.hasOwn(fields, key)) errors.push(`${next} is not supported`)
      else violations(fields[key]!, item, next, errors)
    }
  }
}
export function validate(schema: Schema, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid arguments: expected an object')
  const errors: string[] = []
  violations(schema, raw, '', errors)
  if (errors.length) throw new Error(`invalid arguments: ${errors.join('; ')}`)
  return raw as Record<string, unknown>
}

// Model arguments are frozen by the host. Normalize into a detached object and
// preserve nonblank strings verbatim; only declared optional strings are omitted.
export function omitBlankOptionalStrings(schema: Schema, value: unknown): unknown {
  if (schema.type === 'array' && schema.items && Array.isArray(value)) return value.map(item => omitBlankOptionalStrings(schema.items!, item))
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const fields = schema.properties ?? {}, required = new Set(schema.required ?? [])
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (field?.type === 'string' && !required.has(key) && typeof item === 'string' && !item.trim()) return []
    return [[key, field ? omitBlankOptionalStrings(field, item) : item]]
  }))
}
