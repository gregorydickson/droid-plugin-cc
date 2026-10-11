/** One-shot Droid execution does not support live steering. */
export async function sendWorkerMessage() {
  throw new Error("Live steering is unavailable for one-shot Droid jobs. Cancel or resume with another prompt.");
}
