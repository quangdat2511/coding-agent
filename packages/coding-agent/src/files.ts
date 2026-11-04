// File helpers shared by the steps that read the task file and the Project Instructions.

// The one method of a node:fs/promises FileHandle that readAtMost needs, so tests can pass a fake.
export interface ReadableHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

// Reads from the start of the file until it ends or `limit` bytes have arrived.
export async function readAtMost(handle: ReadableHandle, limit: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await handle.read(buffer, length, limit - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}
