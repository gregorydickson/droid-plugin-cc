import { installFakeDroid } from "./fake-droid-fixture.mjs";
export function installWorkerDroid(binDir, behavior = "review-ok") {
  installFakeDroid(binDir, behavior, true);
}
