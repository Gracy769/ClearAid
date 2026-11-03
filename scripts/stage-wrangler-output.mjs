import { cp, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedOutput = resolve(projectRoot, ".cloudflare", "output");
const workerOutput = resolve(generatedOutput, "v0", "workers", "default");
const stagedOutput = resolve(projectRoot, "dist", "cloudflare-worker");

function assertInsideProject(path) {
  const rel = relative(projectRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to modify a path outside the project: ${path}`);
  }
}

assertInsideProject(generatedOutput);
assertInsideProject(workerOutput);
assertInsideProject(stagedOutput);

await rm(stagedOutput, { recursive: true, force: true });
await cp(workerOutput, stagedOutput, { recursive: true });
await rm(generatedOutput, { recursive: true, force: true });

console.log("Prepared the Cloudflare Worker bundle for Wrangler.");
