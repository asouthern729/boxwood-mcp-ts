import "dotenv/config"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { createServer } from "./mcpServer.js"

const app = createMcpExpressApp({ allowedHosts: ["mcp.tyneside.io"] })

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
    console.error("Error handling MCP request:", error)

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

app.listen(PORT, () => {
  console.log(`tyneside-boxwood-mcp listening on http://127.0.0.1:${ PORT }/mcp`)
})

process.on("SIGINT", () => {
  process.exit(0)
})
