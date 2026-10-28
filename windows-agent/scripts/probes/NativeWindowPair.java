/** Two fresh complete trees on one short-lived UiAutomation connection. */
public final class NativeWindowPair {
    interface Snapshot { String read() throws Exception; }
    interface Pause { void waitForSample() throws Exception; }
    static final class SameWindow implements NativeWindowReader.Backend {
        final NativeWindowReader.Backend backend;
        Long id; int window, connection;
        SameWindow(NativeWindowReader.Backend backend) { this.backend = backend; }
        public NativeWindowReader.Info root() throws Exception {
            NativeWindowReader.Info node = backend.root();
            if (node == null) return null;
            if (id == null) { id = node.id(); window = node.window(); connection = node.connection(); }
            else if (id.longValue() != node.id() || window != node.window() || connection != node.connection()) {
                node.close(); throw new IllegalStateException("pair window identity changed");
            }
            return node;
        }
        public NativeWindowReader.Info fetch(int connection, int window, long id) throws Exception {
            return backend.fetch(connection, window, id);
        }
    }
    static String pair(Snapshot snapshot, Pause pause) throws Exception {
        return pair(snapshot, pause, System::nanoTime);
    }
    static String pair(Snapshot snapshot, Pause pause, java.util.function.LongSupplier clock) throws Exception {
        long started = clock.getAsLong();
        String first = snapshot.read();
        // Keep the existing 20s device/25s host envelope. A slow first
        // snapshot is rejected cleanly before spending another read budget.
        // 2s connection + <=3s first + 2s interval + <=12s second = <=19s.
        if (clock.getAsLong() - started > 3_000_000_000L)
            throw new IllegalStateException("pair initial sample too slow");
        pause.waitForSample();
        String second = snapshot.read();
        if (first.length() > 4_000_000 || second.length() > 4_000_000)
            throw new IllegalStateException("pair size budget exceeded");
        return "<native-pair>" + embedded(first) + embedded(second) + "</native-pair>";
    }
    static String embedded(String xml) {
        // NativeWindowReader emits a document declaration. It is not valid
        // inside another XML document; retain both complete hierarchy bodies.
        String declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
        return xml.startsWith(declaration) ? xml.substring(declaration.length()) : xml;
    }
    public static void main(String[] args) {
        Object wrapper = null; boolean connected = false; String output = null; int code = 1;
        try {
            if (args.length != 0) throw new IllegalArgumentException("no arguments accepted");
            wrapper = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            NativeElementsProbe.call(wrapper, "connect"); connected = true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            Thread.sleep(2000);
            SameWindow backend = new SameWindow(new NativeWindowReader.AndroidBackend(
                NativeElementsProbe.call(wrapper, "getUiAutomation")));
            output = pair(() -> NativeWindowReader.read(backend), () -> Thread.sleep(2000));
            code = 0;
        } catch (Exception e) {
            System.err.println("native_pair_unproven:" + e.getClass().getSimpleName() + ":" + e.getMessage());
        } finally {
            if (connected) try { NativeElementsProbe.call(wrapper, "disconnect"); }
            catch (Exception e) { code = 1; System.err.println("native_disconnect_failed"); }
        }
        if (code == 0) System.out.print(output);
        System.exit(code);
    }
}
