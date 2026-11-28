import { createHash } from "node:crypto";

export interface ExpectedArchive {
  readonly bytes: number;
  readonly sha256: string;
}

export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

/**
 * Reads an HTTP response body while enforcing the expected byte size and SHA-256 digest.
 * Shared by the runtime tool acquirer and the CI setup script so archive verification stays in one
 * place while each caller manages its own retry and abort policies.
 */
export async function readVerifiedArchive(
  response: Response,
  url: string,
  expected: ExpectedArchive,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Content-Length reflects the wire payload before decoding Content-Encoding, so only compare it
  // against the decoded archive size when no transfer/content encoding is applied.
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const isUnencoded = !contentEncoding || contentEncoding === "identity";
  const contentLengthHeader = isUnencoded ? response.headers.get("content-length") : null;
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > expected.bytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArchiveIntegrityError(
        `Size mismatch for ${url}: Content-Length ${declaredLength} exceeds expected ${expected.bytes} bytes`,
      );
    }
  }

  const hash = createHash("sha256");
  const buffer = new Uint8Array(expected.bytes);
  let totalBytes = 0;

  if (response.body) {
    const reader = response.body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("download aborted");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (totalBytes + value.byteLength > expected.bytes) {
          await reader.cancel().catch(() => undefined);
          throw new ArchiveIntegrityError(
            `Size mismatch for ${url}: response exceeded expected ${expected.bytes} bytes`,
          );
        }

        buffer.set(value, totalBytes);
        totalBytes += value.byteLength;
        hash.update(value);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  if (signal?.aborted) {
    throw signal.reason ?? new Error("download aborted");
  }

  if (totalBytes !== expected.bytes) {
    throw new ArchiveIntegrityError(
      `Size mismatch for ${url}: expected ${expected.bytes} bytes, got ${totalBytes}`,
    );
  }

  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== expected.sha256) {
    throw new ArchiveIntegrityError(
      `SHA256 mismatch for ${url}: expected ${expected.sha256}, got ${actualSha256}`,
    );
  }

  return buffer;
}
