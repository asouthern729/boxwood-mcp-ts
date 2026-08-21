const RELATIVE_PATTERN = /^(\d+)(h|d)$/i

export function resolveSince(value: string): Date {
  const match = value.match(RELATIVE_PATTERN)

  if(match) {
    const amount = Number(match[1])
    const unitMs = match[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000

    return new Date(Date.now() - amount * unitMs)
  }

  return parseTimestamp(value, "since")
}

export function resolveUntil(value?: string): Date {
  return value ? parseTimestamp(value, "until") : new Date()
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value)

  if(Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${ field } value: "${ value }" — expected an ISO timestamp, or relative shorthand like "24h"/"7d" for since`)
  }

  return parsed
}
