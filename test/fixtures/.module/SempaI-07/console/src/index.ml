import "coreio";

/**
 * Prints a prefixed line.
 * @param {string} msg - text to print
 */
func log(msg) {
  coreio.print("[log] " + msg);
}

var VERSION = "1.2.3";

export(log, VERSION);
