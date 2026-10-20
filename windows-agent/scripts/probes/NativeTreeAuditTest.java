public final class NativeTreeAuditTest {
    public static void main(String[] args) throws Exception {
        int tests = 0;
        NativeElementsProbeTest.N root = new NativeElementsProbeTest.N();
        root.kids.add(null);
        NativeElementsProbeTest.N sibling = new NativeElementsProbeTest.N();
        root.kids.add(sibling);
        NativeTreeAudit.Audit audit = new NativeTreeAudit.Audit();
        String xml = audit.read(root);
        if (audit.missing != 1 || !xml.contains("<missing index=\"0\"/>") || !sibling.closed
                || xml.contains("<hierarchy") || !root.closed) throw new AssertionError();
        tests++;
        NativeElementsProbeTest.N foreign = new NativeElementsProbeTest.N(); foreign.pkg = "other";
        NativeElementsProbeTest.rejects(() -> new NativeTreeAudit.Audit().read(foreign));
        if (!foreign.closed) throw new AssertionError(); tests++;
        NativeElementsProbeTest.rejects(() -> new NativeTreeAudit.Audit().read(null)); tests++;
        NativeElementsProbeTest.N large = new NativeElementsProbeTest.N();
        for (int i = 0; i < 1501; i++) large.kids.add(null);
        NativeElementsProbeTest.rejects(() -> new NativeTreeAudit.Audit().read(large)); tests++;
        long source = (31L << 32) | 1788, child = (47L << 32) | 1788;
        if (!NativeTreeAudit.canRoute(8621, 533, 8587, 533, 1788, source, child)) throw new AssertionError(); tests++;
        if (NativeTreeAudit.canRoute(8621, 533, 8587, 534, 1788, source, child)) throw new AssertionError(); tests++;
        if (NativeTreeAudit.canRoute(8621, 533, 8587, 533, 1789, source, child)) throw new AssertionError(); tests++;
        if (NativeTreeAudit.canRoute(8621, 533, 8621, 533, 1788, source, child)) throw new AssertionError(); tests++;
        if (NativeTreeAudit.canRoute(8621, 533, 8587, 533, 1788, source, child + 1)) throw new AssertionError(); tests++;
        if (NativeTreeAudit.canRoute(-1, 533, 8587, 533, 1788, source, child)) throw new AssertionError(); tests++;
        System.out.println("NativeTreeAudit tests passed: " + tests);
    }
}
