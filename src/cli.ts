import { run } from "./index.js";

run(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`nodeploy: ${message}`);
  process.exitCode = 1;
});
