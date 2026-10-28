import java.util.*;
public final class NativeWorksSessionProbeTest {
    static final class N implements NativeNavigationAction.Node {
        String text, pkg = "com.xingin.xhs"; boolean visible = true, clickable = true;
        List<NativeNavigationAction.Node> kids = new ArrayList<>();
        N(String text) { this.text = text; }
        public String value(String key) {
            if (key.equals("package")) return pkg;
            if (key.equals("text")) return text;
            if (key.equals("class")) return "android.widget.TextView";
            if (key.equals("enabled")) return "true";
            if (key.equals("clickable")) return "" + clickable;
            return "";
        }
        public boolean visible() { return visible; }
        public boolean refresh() { throw new AssertionError(); }
        public boolean click() { throw new AssertionError(); }
        public int children() { return kids.size(); }
        public NativeNavigationAction.Node child(int i) { return kids.get(i); }
        public List<NativeNavigationAction.Node> query(String s) { throw new AssertionError(); }
        public NativeNavigationAction.Node parent() { throw new AssertionError(); }
        public NativeNavigationAction.Node inputFocus() { throw new AssertionError(); }
        public void close() {}
    }
    static List<NativeNavigationAction.Node> tabs() {
        return new ArrayList<>(Arrays.asList(new N("账号概览"), new N("作品分析"), new N("粉丝数据"), new N("收入数据")));
    }
    public static void main(String[] args) throws Exception {
        int tests = 0;
        List<NativeNavigationAction.Node> good = tabs();
        if (NativeWorksSessionProbe.target(good) != good.get(1)) throw new AssertionError(); tests++;
        List<NativeNavigationAction.Node> missing = tabs(); missing.remove(0);
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.target(missing)); tests++;
        List<NativeNavigationAction.Node> duplicate = tabs(); duplicate.add(new N("作品分析"));
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.target(duplicate)); tests++;
        List<NativeNavigationAction.Node> already = tabs(); already.add(new N("全部笔记"));
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.target(already)); tests++;
        List<NativeNavigationAction.Node> foreign = tabs(); ((N)foreign.get(1)).pkg = "other";
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.target(foreign)); tests++;
        List<NativeNavigationAction.Node> disabled = tabs(); ((N)disabled.get(1)).clickable = false;
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.target(disabled)); tests++;
        N root = new N(""); root.kids.add(null); root.kids.addAll(tabs());
        List<NativeNavigationAction.Node> walked = new ArrayList<>();
        NativeWorksSessionProbe.findHeader(root, walked, 0, System.nanoTime() + 1_000_000_000L);
        if (walked.size() != 4 || NativeWorksSessionProbe.target(walked) != walked.get(1)) throw new AssertionError();
        tests++;
        NativeElementsProbeTest.rejects(() -> NativeWorksSessionProbe.findHeader(root, new ArrayList<>(), 0, 0)); tests++;
        System.out.println("NativeWorksSessionProbe tests passed: " + tests);
    }
}
