import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import inspector from "node:inspector";
import os from "node:os";
import path from "node:path";
import { runBenchmark } from "./benchmark.js";

function post(session, method) {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function main() {
  const session = new inspector.Session();
  session.connect();
  let profilerEnabled = false;
  try {
    await post(session, "Profiler.enable");
    profilerEnabled = true;
    await post(session, "Profiler.start");
    const benchmark = await runBenchmark();
    const { profile } = await post(session, "Profiler.stop");
    profilerEnabled = false;
    const profilePath = path.join(
      os.tmpdir(),
      `cleanser-${process.pid}-${randomUUID()}.cpuprofile`,
    );
    await fs.writeFile(profilePath, JSON.stringify(profile), { flag: "wx" });
    console.log(JSON.stringify({ ...benchmark, profilePath }, null, 2));
  } finally {
    if (profilerEnabled) {
      await post(session, "Profiler.stop").catch(() => {});
    }
    session.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
