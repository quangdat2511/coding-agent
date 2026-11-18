// Helpers for the text that Coding Agent prints and shows, shared by both entry points.

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A provider error or a file the model read can carry the credential into what is printed or shown.
export function redactorOf(credential: { reveal(): string }): (text: string) => string {
  return (text) => text.replaceAll(credential.reveal(), "[redacted]");
}
