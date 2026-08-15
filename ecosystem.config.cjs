module.exports = {
  apps: [
    {
      name: "boxwood-mcp-ts",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      out_file: "/var/log/boxwood-mcp/access/access.log",
      error_file: "/var/log/boxwood-mcp/error/error.log",
      combine_logs: true,
      env: {
        NODE_ENV: "production",
        // Dev-only tools must never run in production, regardless of .env —
        // process.env set here wins over dotenv's config() since dotenv
        // does not overwrite variables that already exist.
        ENABLE_DEV_TOOLS: "false"
      }
    }
  ]
}
