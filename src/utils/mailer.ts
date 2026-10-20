// Sends through Resend's HTTPS API (Andrew moved off SES, 2026-10-20). Over HTTPS because this
// DigitalOcean droplet blocks outbound SMTP ports (25/465/587) — a direct SMTP transport just hangs
// until it times out (confirmed live). Same provider as the ams360-etl project's send_alert.py.
//
// Needs RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend, e.g.
// "Boxwood MCP <noreply@mail.tyneside.io>"). Both are read when a message is sent, not at module
// load, so scripts that never send mail don't need them set.

const RESEND_URL = "https://api.resend.com/emails"
const SEND_TIMEOUT_MS = 30_000

export type MailAttachment = { filename: string; content: Buffer; contentType: string }

const list = (value: string | string[] | undefined) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])

export async function sendMail(opts: {
  to: string | string[]
  cc?: string | string[]
  subject: string
  text?: string
  attachments?: MailAttachment[]
}): Promise<void> {
  const { RESEND_API_KEY, MAIL_FROM } = process.env
  if(!RESEND_API_KEY) throw new Error("RESEND_API_KEY must be set to send email")
  if(!MAIL_FROM) throw new Error("MAIL_FROM must be set to send email (an address on a domain verified in Resend)")

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ RESEND_API_KEY }`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: list(opts.to),
      cc: list(opts.cc),
      subject: opts.subject,
      text: opts.text ?? "",
      attachments: opts.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType }))
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  })

  if(!res.ok) {
    // Resend's error body is { statusCode, name, message } — never the key or the message content.
    const detail = await res.text().catch(() => "")
    throw new Error(`Resend rejected the email: HTTP ${ res.status } ${ detail.slice(0, 300) }`)
  }
}

export async function sendMailWithAttachment(opts: {
  to: string | string[]
  cc?: string | string[]
  subject: string
  text?: string
  attachment: MailAttachment
}): Promise<void> {
  const { attachment, ...rest } = opts
  await sendMail({ ...rest, attachments: [attachment] })
}
