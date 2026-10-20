import java.util.*;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
public final class NativeElementsProbeTest {
    static class N implements NativeElementsProbe.Node {
        boolean visible = true, closed;
        String text = "标题 & <测> \"😀\"\n", pkg = "com.xingin.xhs";
        List<N> kids = new ArrayList<>();
        public boolean visible() { return visible; }
        public int children() { if (!visible) throw new AssertionError("invisible subtree traversed"); return kids.size(); }
        public NativeElementsProbe.Node child(int i) { return kids.get(i); }
        public String value(String k) { return k.equals("package") ? pkg : k.equals("text") ? text : k.equals("bounds") ? "[1,2][100,200]" : ""; }
        public void close() { closed = true; }
    }
    interface Run { void go() throws Exception; }
    static void rejects(Run f) throws Exception { try { f.go(); } catch (IllegalStateException | IllegalArgumentException expected) { return; } throw new AssertionError("accepted incomplete snapshot"); }
    public static void main(String[] args) throws Exception {
        int tests = 0;
        N root = new N(); N hidden = new N(); hidden.visible = false; hidden.kids.add(null); root.kids.add(hidden);
        String xml = new NativeElementsProbe.Reader().read(root);
        String text = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))).getElementsByTagName("node").item(0).getAttributes().getNamedItem("text").getNodeValue();
        if (!text.equals(root.text) || !root.closed || !hidden.closed) throw new AssertionError(); tests++;
        N missing = new N(); missing.kids.add(null); rejects(() -> new NativeElementsProbe.Reader().read(missing)); if (!missing.closed) throw new AssertionError(); tests++;
        N foreign = new N(); foreign.pkg = "other"; rejects(() -> new NativeElementsProbe.Reader().read(foreign)); tests++;
        N deep = new N(), end = deep; for (int i=0;i<82;i++) { N n=new N();end.kids.add(n);end=n; } rejects(() -> new NativeElementsProbe.Reader().read(deep)); tests++;
        N wide = new N(); for(int i=0;i<2501;i++)wide.kids.add(new N());rejects(() -> new NativeElementsProbe.Reader().read(wide)); tests++;
        rejects(() -> NativeElementsProbe.escaped("bad\u0000")); tests++;
        N invisible = new N(); invisible.visible=false;rejects(() -> new NativeElementsProbe.Reader().read(invisible)); tests++;
        rejects(() -> new NativeElementsProbe.Reader().read(null)); tests++;
        System.out.println("NativeElementsProbe tests passed: " + tests);
    }
}
