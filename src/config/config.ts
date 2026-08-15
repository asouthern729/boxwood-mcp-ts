// TEMP: testing against boxwood_ams360_test via the mcp.tyneside.io domain
// (DNS/TLS already live there). Swap back to "mcp.boxwoodins.com" once
// that domain's DNS is live and this is ready to point at the real DB.
export const allowedHosts = process.env.NODE_ENV === "production" ?
  ["mcp.tyneside.io"] :
  ["mcp.tyneside.io", "localhost", "127.0.0.1"]

export const publicBaseUrl = `https://${ allowedHosts[0] }`
