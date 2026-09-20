module.exports = {
  apps: [
    {
      name: "boxwood-mcp-ts",
      script: "dist/app.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      out_file: "/var/log/boxwood-mcp/access/access.log",
      error_file: "/var/log/boxwood-mcp/error/error.log",
      combine_logs: true,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "boxwood-tools-vite-ts",
      script: "npm",
      args: "run dev",
      cwd: "/home/andrew/apps/boxwood-tools-vite-ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      out_file: "/var/log/boxwood-tools/access/access.log",
      error_file: "/var/log/boxwood-tools/error/error.log",
      combine_logs: true,
      env: {
        NODE_ENV: "development"
      }
    }
  ]
}
