import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp();

  await app.listen({ port: config.port, host: config.host });
  // Render requires binding 0.0.0.0; log line doubles as the deploy-readiness signal
  app.log.info(`dprelay-server listening on ${config.host}:${config.port}`);
}

main().catch((err) => {
  // Fail fast so Render surfaces the crash instead of hanging the deploy
  console.error(err);
  process.exit(1);
});
