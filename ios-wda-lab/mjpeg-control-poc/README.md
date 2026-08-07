# iOS WDA MJPEG Local POC

This is a localhost-only experiment. It does not call Phone Cloud services.

1. Start WebDriverAgent with `MJPEG_SERVER_PORT=9100`.
2. Forward both ports over USB:
   `iproxy -u <device-udid> 8100:8100 9100:9100`
3. Start the local page:
   `node server.mjs`
4. Open `http://127.0.0.1:8794`, then select **连接 iPhone**.

The server owns the temporary WDA session. Closing it releases that session.
