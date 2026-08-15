import { Router } from "express"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer } from "../mcpServer.js"
import { verifyAccessToken } from "../utils/auth0.js"
import { publicBaseUrl } from "../config/config.js"
import { logger } from "../utils/logger.js"

export const router = Router()

const WWW_AUTHENTICATE = `Bearer resource_metadata="${ publicBaseUrl }/.well-known/oauth-protected-resource"`

router.use("/mcp", async (req, res, next) => {
  const authHeader = req.header("authorization") ?? ""
  const [scheme, token] = authHeader.split(" ")

  if(scheme !== "Bearer" || !token) {
    res.status(401).header("WWW-Authenticate", WWW_AUTHENTICATE).json({
      error: "invalid_request",
      error_description: "Missing bearer token"
    })
    return
  }

  try {
    await verifyAccessToken(token)
    next()
  } catch(error) {
    logger.warn({ err: error }, "Rejected invalid bearer token")
    res.status(401).header("WWW-Authenticate", WWW_AUTHENTICATE).json({
      error: "invalid_token",
      error_description: "The access token is invalid or expired"
    })
  }
})

router.post("/mcp", async (req, res) => {
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

router.get("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  }))
})

router.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  }))
})
