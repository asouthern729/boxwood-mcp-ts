import "dotenv/config"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { createServer } from "./mcpServer.js"
import { logger } from "./logger.js"

const allowedHosts = process.env.NODE_ENV === "production" ?
  ["mcp.boxwoodins.com"] :
  ["mcp.boxwoodins.com", "localhost", "127.0.0.1"]

const app = createMcpExpressApp({ allowedHosts })

app.post("/mcp", async (req, res) => {
  const server = createServer()

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)

    res.on("close", () => {
      transport.close()
      server.close()
    })
  } catch(error) {
    logger.error({ err: error }, "Error handling MCP request")

    if(!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      })
    }
  }
})

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  }))
})

app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  }))
})

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST

app.listen(PORT, HOST as any, () => {
  logger.info(`boxwood-mcp-ts listening on http://${ HOST ?? "0.0.0.0" }:${ PORT }/mcp`)
})

process.on("SIGINT", () => {
  process.exit(0)
})
