import "dotenv/config"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { allowedHosts } from "./config/config.js"
import { logger } from "./utils/logger.js"
import errorHandler from "./middleware/error/index.js"
import csp from "./middleware/csp/index.js"
import inputSanitation from "./middleware/inputSanitation/index.js"

// Routers
import { router as mcpRouter } from "./routes/mcp.js"
import { router as wellKnownRouter } from "./routes/wellKnown.js"
import { router as authRouter } from "./routes/auth.js"
import { router as downloadsRouter } from "./routes/downloads.js"
import { router as employeesRouter } from "./routes/employees.js"
import { router as reportsRouter } from "./routes/reports.js"
import { router as renewalSummariesRouter } from "./routes/renewalSummaries.js"
import { router as boardRouter } from "./routes/board.js"

const app = createMcpExpressApp({ allowedHosts })

// Mount routers
app.use(mcpRouter)
app.use(wellKnownRouter)
app.use(authRouter)
app.use(downloadsRouter)
app.use(employeesRouter)
app.use(reportsRouter)
app.use(renewalSummariesRouter)
app.use(boardRouter)

app.use(csp)
app.use(inputSanitation)
app.use(errorHandler)

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST

app.listen(PORT, HOST as any, () => {
  logger.info(`boxwood-mcp-ts listening on http://${ HOST ?? "0.0.0.0" }:${ PORT }/mcp`)
})

process.on("SIGINT", () => {
  process.exit(0)
})
