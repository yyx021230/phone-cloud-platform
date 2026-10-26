public final class NativeWindowPairTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        int[] calls = {0, 0};
        String xml = NativeWindowPair.pair(() -> "<hierarchy sample=\"" + (++calls[0]) + "\"/>", () -> calls[1]++);
        check(calls[0] == 2 && calls[1] == 1 && xml.contains("sample=\"1\"") && xml.contains("sample=\"2\""));
        try { NativeWindowPair.pair(() -> { throw new IllegalStateException("missing"); }, () -> calls[1]++); throw new AssertionError(); }
        catch (IllegalStateException expected) { check(calls[1] == 1); }
        NativeWindowReaderTest.B backend = new NativeWindowReaderTest.B();
        NativeWindowPair.SameWindow stable = new NativeWindowPair.SameWindow(backend);
        check(stable.root() == backend.root && stable.root() == backend.root);
        backend.last = new NativeWindowReaderTest.N(999);
        try { stable.root(); throw new AssertionError(); }
        catch (IllegalStateException expected) { check(backend.last.closed == 1); }
        // Exercise real serializer output, including its XML declaration.
        NativeWindowReaderTest.B real = new NativeWindowReaderTest.B();
        NativeWindowPair.SameWindow realWindow = new NativeWindowPair.SameWindow(real);
        String document = NativeWindowPair.pair(() -> NativeWindowReader.read(realWindow), () -> {});
        org.w3c.dom.Document parsed = javax.xml.parsers.DocumentBuilderFactory.newInstance()
            .newDocumentBuilder().parse(new java.io.ByteArrayInputStream(document.getBytes("UTF-8")));
        check(parsed.getElementsByTagName("hierarchy").getLength() == 2 && real.roots == 4);
        check(real.fetches == 4); // Fresh native fetches for both trees.
        int[] failed = {0};
        try { NativeWindowPair.pair(() -> {
            if (++failed[0] == 2) throw new IllegalStateException("second read incomplete");
            return "<hierarchy/>";
        }, () -> {}); throw new AssertionError(); }
        catch (IllegalStateException expected) { check(failed[0] == 2); }
        for (int change = 0; change < 2; change++) {
            NativeWindowReaderTest.B changed = new NativeWindowReaderTest.B();
            NativeWindowPair.SameWindow tracked = new NativeWindowPair.SameWindow(changed);
            tracked.root(); changed.last = new NativeWindowReaderTest.N(1);
            if (change == 0) changed.last.win++; else changed.last.conn++;
            try { tracked.root(); throw new AssertionError(); }
            catch (IllegalStateException expected) { check(changed.last.closed == 1); }
        }
        long[] clock = {0}; int[] slow = {0, 0};
        try { NativeWindowPair.pair(() -> {
            slow[0]++; clock[0] = 3_000_000_001L; return "<hierarchy/>";
        }, () -> slow[1]++, () -> clock[0]); throw new AssertionError(); }
        catch (IllegalStateException expected) { check(slow[0] == 1 && slow[1] == 0); }
        System.out.println("9 native pair checks passed");
    }
}
