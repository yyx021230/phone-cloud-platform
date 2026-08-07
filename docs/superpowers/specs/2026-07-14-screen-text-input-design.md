# Screen Text Input Design

## Goal

Add explicit text entry to the existing Android scrcpy screen-control workspace without exposing automatic clipboard synchronization to the browser or platform.

## User Experience

- The live-control workspace shows one compact text field, a send button, a delete button, and an enter button below the phone frame.
- Controls stay disabled until the screen session is live.
- The user focuses a text field on the phone, enters text in the web field, and explicitly sends it.
- Enter submits the web field. Shift+Enter is not applicable because the field is single-line.
- The web field clears only after a non-empty value is accepted for sending.

## Protocol And Execution

- Text uses `{ type: "text", text, sequenceId }`.
- Enter and delete reuse key messages with `key: "enter"` and `key: "delete"`.
- The server rejects empty text, NUL characters, and values longer than 1000 UTF-16 code units.
- The Agent serializes text with touch and key controls and calls scrcpy `setClipboard({ sequence, paste: true, content })`.
- The scrcpy acknowledgement channel is enabled internally; inbound phone clipboard values are not forwarded, stored, or logged.
- Logs and acknowledgements contain only action names and timing, never text content.

## Verification

- Unit tests cover protocol validation, control ordering, UI wiring, and key mapping.
- Real-device verification covers English, numbers, Chinese, delete, and enter through the deployed web protocol.
