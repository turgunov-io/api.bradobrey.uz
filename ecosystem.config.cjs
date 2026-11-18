module.exports = {
  apps: [
    {
      name: "BRADOBREY-BARBER",
      script: "src/server.js",
      // dotenv reads .env from cwd; pin it so PM2 finds it regardless of where it is started.
      cwd: __dirname
    }
  ]
};
