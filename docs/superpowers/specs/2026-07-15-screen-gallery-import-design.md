# Screen Gallery Import Design

## Goal

Let a user import one image into the gallery of the phone currently owned by their active screen-control session.

## Flow

1. The user opens the `实时控制` tab and starts a screen-control session.
2. The user selects a PNG, JPEG, or WebP image from the new import control.
3. The browser sends a validated image data URL to a screen-session import endpoint.
4. The server verifies the authenticated user owns the active session, verifies the session device is still online and bound to its Windows Agent, then creates a short-lived `screen_gallery_import` Windows task.
5. The Windows Agent writes the image to its cache, pushes it to `/sdcard/Pictures/PhoneCloud/`, and triggers Android media scanning.
6. The task result returns to the client as a compact status message. The image is not retained in server state after the Windows Agent has received it.

## Constraints

- Import is only enabled while the current screen-control session is live or connecting; it never targets an arbitrary device id from the browser.
- Files are limited to PNG, JPEG, and WebP, with the existing 3 MB image limit and magic-byte validation.
- The server and Agent authorize the task with the existing agent/task binding. A task can only be claimed by the bound Windows Agent.
- The Windows Agent uses the existing ADB push and media-scan primitives. No new device APK, permission, or screen-control protocol is required.
- The server records an audit event without storing the image contents or filename.

## UI

The real-time control toolbar gains an `导入图片` file button and a short status line. The button is disabled unless the current session owns the selected device. While uploading, it shows `正在导入…`; on success it shows that the image is visible in the phone gallery; on failure it presents the safe server error.

## Verification

- Unit tests cover session ownership, invalid image rejection, task type authorization, and Agent push/scan dispatch.
- Browser smoke coverage confirms the button is enabled only for the current live session and sends the current session id.
- A device test imports a small PNG and verifies Android media scan receives the target gallery path.
