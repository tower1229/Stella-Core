import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (typeof address !== "object" || address === null) {
    throw new Error("Exact Host Gateway did not allocate a loopback port");
  }
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(milliseconds),
  ]);
}

export async function startExactHostGateway({ cwd, env, openclawBin }) {
  const port = await allocateLoopbackPort();
  const token = randomBytes(32).toString("hex");
  const gatewayEnv = {
    ...process.env,
    ...env,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
  };
  const child = spawn(openclawBin, [
    "gateway",
    "run",
    "--allow-unconfigured",
    "--bind",
    "loopback",
    "--auth",
    "token",
    "--port",
    String(port),
    "--ws-log",
    "compact",
  ], {
    cwd,
    env: gatewayEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupOutput = "";
  const capture = (chunk) => {
    startupOutput = `${startupOutput}${chunk}`.slice(-8_192);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  try {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        await execFileAsync(openclawBin, ["health", "--json", "--timeout", "1000"], {
          cwd,
          env: gatewayEnv,
        });
        return {
          env: gatewayEnv,
          diagnostics: () => startupOutput
            .split("\n")
            .filter((line) =>
              line.includes("Stella Praxis") || line.includes("Stella semantic routing failed")
            )
            .slice(-20)
            .join("\n"),
          stop: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await waitForExit(child, 5_000);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await waitForExit(child, 5_000);
          },
        };
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    throw new Error(`Exact Host Gateway did not become healthy: ${startupOutput.trim()}`, {
      cause: lastError,
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child, 5_000);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  }
}
