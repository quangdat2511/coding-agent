// Process helpers the bash and Verification Runner tests share.

// A killed process can linger as a zombie until its new parent reaps it, and signal 0 still
// reaches a zombie, so wait briefly for it to disappear.
export async function exitsSoon(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 2_000; waited += 50) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
