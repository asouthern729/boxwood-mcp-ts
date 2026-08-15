import pino from "pino"

const isProd = process.env.NODE_ENV === "production"
const level = process.env.LOG_LEVEL || "info"

export const logger = pino({
  level,
  transport: isProd ?
    {
      // PM2 splits stdout/stderr into separate log files, so send everything
      // to stdout and duplicate error+ onto stderr to populate error.log.
      targets: [
        { target: "pino/file", level, options: { destination: 1 } },
        { target: "pino/file", level: "error", options: { destination: 2 } }
      ]
    } :
    { target: "pino-pretty", options: { colorize: true } }
})
