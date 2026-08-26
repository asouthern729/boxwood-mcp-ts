export const allowedHosts = process.env.NODE_ENV === "production" ?
  ["mcp.boxwoodins.com"] :
  ["127.0.0.1"]

export const publicBaseUrl = `https://${ allowedHosts[0] }`
