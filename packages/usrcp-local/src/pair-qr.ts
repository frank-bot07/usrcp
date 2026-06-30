import qrcode from "qrcode-terminal";

/**
 * Render the pairing string as an ASCII QR code suitable for a terminal.
 * Returns the rendered string rather than printing so the caller controls
 * where it goes (stderr in the CLI, captured stdout in tests, etc).
 *
 * Presentation layer — lives in usrcp-local, not usrcp-core, so the protocol
 * core stays free of terminal dependencies. The pairing protocol itself is in
 * `usrcp-core/pair`.
 *
 * `small: true` uses half-block Unicode characters so the QR fits in roughly
 * half the cells of the default rendering - the v2 pairing string is short
 * enough (~45 chars including hyphens) that even at QR error-correction level L
 * the result is a manageable ~25x25 module grid.
 */
export function renderPairingQr(pairingString: string): string {
  let captured = "";
  qrcode.generate(pairingString, { small: true }, (qr: string) => {
    captured = qr;
  });
  return captured;
}
