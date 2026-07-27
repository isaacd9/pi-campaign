import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiSdkKernel } from "../../src/adapters/pi-sdk-kernel.ts";

const RESULT_PATH = "/tmp/campaign-real-smoke-result.txt";
const OUTPUT_PATH = "/tmp/campaign-real-smoke-output.txt";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const kernel = new PiSdkKernel();
    let result: string;
    try {
      const ping = await kernel.ping();
      const run = await kernel.spawn({
        agent: "scout",
        task: "Return exactly CAMPAIGN_NATIVE_SMOKE_OK. Do not use tools.",
        cwd: ctx.cwd,
        outputPath: OUTPUT_PATH,
      });
      result = "FAILED timeout";
      for (let attempt = 0; attempt < 240; attempt++) {
        const status = await kernel.status(run);
        if (status.state === "complete") {
          const output = String(status.output ?? "").trim();
          result = output === "CAMPAIGN_NATIVE_SMOKE_OK"
            ? `OK native=${ping.version} output=exact`
            : `FAILED unexpected output ${JSON.stringify(output.slice(0, 500))}`;
          break;
        }
        if (["failed", "stopped", "paused"].includes(status.state)) throw new Error(`${status.state}: ${status.error ?? ""}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      result = `FAILED ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      kernel.dispose();
    }
    await writeFile(RESULT_PATH, result);
  });
  pi.registerCommand("campaign-smoke", { description: "Run the Campaign native-kernel smoke fixture", handler: async () => {} });
}
