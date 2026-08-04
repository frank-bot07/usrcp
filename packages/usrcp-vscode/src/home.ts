import { homedir } from "node:os";
import { isAbsolute } from "node:path";

/**
 * The user's home directory, or a clear failure: a local mirror of
 * usrcp-core's requireHomeDir() (#174/#183). usrcp-vscode deliberately does
 * not depend on usrcp-core (that would pull the ledger and node:sqlite into
 * the extension bundle), so the guard is duplicated here rather than imported.
 *
 * os.homedir() returns "" when HOME is set but empty, and every path built
 * from it then quietly becomes RELATIVE, so a `.usrcp` tree could be created
 * in whatever directory the extension host started in. Refusing is the only
 * safe answer (#192).
 */
export function requireHomeDir(): string {
  const home = homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error(
      "HOME is unset or empty, so there is no home directory to resolve the " +
      "USRCP paths against. Set HOME to an absolute path (or set USRCP_HOME).",
    );
  }
  return home;
}
