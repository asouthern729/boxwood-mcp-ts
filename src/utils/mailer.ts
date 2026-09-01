import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2"
import nodemailer from "nodemailer"

// Sends via the SES HTTPS API rather than SMTP — this runs on a DigitalOcean droplet, which
// blocks outbound SMTP ports (25/465/587) by default, so a direct SMTP transport just hangs until
// it times out (confirmed live; same issue independently hit and worked around the same way by
// the ams360-etl project's boto3-based mailer). Nodemailer still builds the MIME message
// (including the attachment) locally; only the final send goes over HTTPS via the AWS SDK. This
// needs real AWS IAM credentials with ses:SendEmail permission — NOT the SES *SMTP* username/
// password, which are a derived credential valid only for SMTP AUTH, not API calls. Env var names
// (AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/MAIL_FROM) match ams360-etl's convention.
//
// Lazily built and cached — env vars are read once, on first send, rather than at module-load
// time, so scripts/tests that don't send mail never need AWS_*/MAIL_FROM set at all.
let transporter: nodemailer.Transporter | undefined

function getTransporter(): nodemailer.Transporter {
  if(transporter) return transporter

  const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env

  if(!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY must all be set to send email")
  }

  const sesClient = new SESv2Client({
    region: AWS_REGION,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
  })

  transporter = nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } })

  return transporter
}

export type MailAttachment = { filename: string; content: Buffer; contentType: string }

export async function sendMailWithAttachment(opts: {
  to: string | string[]
  subject: string
  text?: string
  attachment: MailAttachment
}): Promise<void> {
  const from = process.env.MAIL_FROM

  if(!from) {
    throw new Error("MAIL_FROM must be set to send email (must be a verified SES sender identity)")
  }

  await getTransporter().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: [opts.attachment]
  })
}
