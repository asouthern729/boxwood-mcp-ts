import { Model } from "sequelize"
import { convertUtcInstantToLocal } from "../../utils/localTime.js"

// boxwood_mcp.items/comments' created_at/updated_at are real `timestamptz` columns — genuine UTC
// instants (unlike the legacy afw_* tables' naive local-wall-clock timestamps handled by
// formatTimestampColumn/TRUE_UTC_COLUMNS) — so these always need convertUtcInstantToLocal, never
// the "reinterpret as local" treatment. Without this, every board tool's JSON output carries raw
// UTC ISO strings with no timezone context, and Claude (unlike a browser rendering the web page)
// has no separate local-timezone conversion step — it just reports the UTC string as-is.
function localizeDates(plain: Record<string, unknown>) {
  if(plain.created_at instanceof Date) plain.created_at = convertUtcInstantToLocal(plain.created_at)
  if(plain.updated_at instanceof Date) plain.updated_at = convertUtcInstantToLocal(plain.updated_at)
  return plain
}

// Accepts a Sequelize model instance (Item, optionally with its nested `comments` include, or a
// bare Comment) and returns a plain object safe to hand straight to textResult — every
// created_at/updated_at (including on nested comments) converted to agency-local time.
export function toLocalizedPlain(model: Model) {
  const plain = model.get({ plain: true }) as Record<string, unknown>

  localizeDates(plain)

  if(Array.isArray(plain.comments)) {
    plain.comments = plain.comments.map((comment) => localizeDates({ ...(comment as Record<string, unknown>) }))
  }

  return plain
}
