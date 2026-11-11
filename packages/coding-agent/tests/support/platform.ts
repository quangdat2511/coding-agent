// Why a test cannot run as written on this host. Each test that checks one says so with skipIf.
export const onWindows = process.platform === "win32";

// Windows has no FIFOs; Git Bash's mkfifo makes an MSYS emulation that Bun sees as missing.
export const noFifos = onWindows;
// Windows keeps only a read-only attribute, not POSIX mode bits.
export const noModeBits = onWindows;
// Root ignores file permissions and Windows has no POSIX mode bits or umask, so those tests skip.
export const permissionsIgnored = process.getuid?.() === 0 || onWindows;
