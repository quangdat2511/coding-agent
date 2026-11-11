// Why a test cannot run as written on this host. Each test that checks one says so with skipIf.
const onWindows = process.platform === "win32";

// Windows has no FIFOs; Git Bash's mkfifo makes an MSYS emulation that Bun sees as missing.
export const noFifos = onWindows;
// Windows keeps only a read-only attribute, not POSIX mode bits.
export const noModeBits = onWindows;
// Root ignores file permissions and Windows has no POSIX ones, so some tests simulate a refusal
// and the rest skip.
export const permissionsIgnored = process.getuid?.() === 0 || onWindows;
// Win32 file names cannot hold control characters such as a newline.
export const noNewlineNames = onWindows;
// Windows reports a component longer than the file system allows as missing, not ENAMETOOLONG.
export const noNameTooLong = onWindows;
// Windows refuses to inspect a Unix-domain socket file, so the resolver refuses it before read can
// see its type.
export const socketRefusal = onWindows ? "permission denied" : "not a regular file";
