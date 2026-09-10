import helmet from 'helmet'

export default helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'trusted-scripts.com'],
    objectSrc: ["'none'"],
    upgradeInsecureRequests: [],
  }
})