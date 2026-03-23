import { createGateway, GatewayConfig } from "./server";

const config: GatewayConfig = {
  port: parseInt(process.env.GATEWAY_PORT || "8888", 10),
  ccrUrl: process.env.CCR_URL || "http://localhost:3456",
  logLevel: process.env.LOG_LEVEL || "info",
};

async function main() {
  const app = await createGateway(config);

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`OpenAI Gateway listening on http://0.0.0.0:${config.port}`);
    console.log(`Forwarding to CCR at ${config.ccrUrl}`);
  } catch (err) {
    console.error("Failed to start gateway:", err);
    process.exit(1);
  }
}

main();
