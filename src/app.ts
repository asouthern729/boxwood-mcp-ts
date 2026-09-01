import "dotenv/config"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { allowedHosts } from "./config/config.js"
import { logger } from "./utils/logger.js"
import { router as mcpRouter } from "./routes/mcp.js"
import { router as wellKnownRouter } from "./routes/wellKnown.js"
import { router as authRouter } from "./routes/auth.js"
import { router as downloadsRouter } from "./routes/downloads.js"

const app = createMcpExpressApp({ allowedHosts })

app.use(mcpRouter)
app.use(wellKnownRouter)
app.use(authRouter)
app.use(downloadsRouter)

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST

app.listen(PORT, HOST as any, () => {
  logger.info(`boxwood-mcp-ts listening on http://${ HOST ?? "0.0.0.0" }:${ PORT }/mcp`)
})

process.on("SIGINT", () => {
  process.exit(0)
})
