export function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
  }
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  }
}

export function groupByKey<T extends Record<string, unknown>>(rows: T[], key: string) {
  const groups = new Map<string, T[]>()

  for(const row of rows) {
    const id = String(row[key])
    const existing = groups.get(id)

    if(existing) {
      existing.push(row)
    } else {
      groups.set(id, [row])
    }
  }

  return groups
}
