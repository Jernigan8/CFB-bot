export async function probeEaCloud() {
  return {
    available: false,
    reason: "No official CFB Online Dynasty API endpoint has been verified. Add a connector here only after you have a documented, authorized, read-only endpoint."
  };
}
