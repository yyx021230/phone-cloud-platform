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
        System.out.println("NativeTreeAudit tests passed: " + tests);
    }
}
