import java.util.*;

/** One proven works-tab click, then native reads while the same connection stays open. */
public final class NativeWorksSessionProbe {
    static boolean label(NativeNavigationAction.Node n, String value) throws Exception {
        return n.visible() && "com.xingin.xhs".equals(n.value("package"))
            && value.equals(n.value("text")) && "android.widget.TextView".equals(n.value("class"));
    }
    static NativeNavigationAction.Node target(List<NativeNavigationAction.Node> nodes) throws Exception {
        Set<String> required = new HashSet<>(Arrays.asList("账号概览", "作品分析", "粉丝数据", "收入数据"));
        Set<String> seen = new HashSet<>();
        NativeNavigationAction.Node target = null;
        for (NativeNavigationAction.Node n : nodes) {
            if (!"com.xingin.xhs".equals(n.value("package"))) throw new IllegalStateException("foreign tab node");
            if (label(n, "全部笔记")) throw new IllegalStateException("already on works page");
            for (String name : Arrays.asList("账号概览", "作品分析", "粉丝数据", "收入数据")) if (label(n, name)) {
                if (!seen.add(name)) throw new IllegalStateException("duplicate overview label");
                required.remove(name);
            }
            if (label(n, "作品分析")) {
                if (target != null) throw new IllegalStateException("ambiguous works tab");
                target = n;
            }
        }
        if (!required.isEmpty() || target == null || !"true".equals(target.value("clickable"))
                || !"true".equals(target.value("enabled"))) throw new IllegalStateException("overview tabs unproven");
        return target;
    }
    static void open(Object root) throws Exception {
        NativeNavigationAction.AndroidNode r = new NativeNavigationAction.AndroidNode(root);
        List<NativeNavigationAction.Node> all = new ArrayList<>();
        try {
            if (!"com.xingin.xhs".equals(r.value("package")) || !r.visible())
                throw new IllegalStateException("XHS root required");
            for (String label : new String[]{"账号概览", "作品分析", "粉丝数据", "收入数据", "全部笔记"}) {
                List<NativeNavigationAction.Node> found = r.query(label);
                all.addAll(found);
                if (all.size() > 40) throw new IllegalStateException("tab query budget");
            }
            NativeNavigationAction.Node n = target(all);
            if (!n.refresh() || target(all) != n) throw new IllegalStateException("works tab changed");
            int[] bounds = NativeElementsProbe.Reader.box(new NativeElementsProbe.AndroidNode(
                ((NativeNavigationAction.AndroidNode)n).n).value("bounds"));
            int[] window = NativeElementsProbe.Reader.box(new NativeElementsProbe.AndroidNode(root).value("bounds"));
            if (bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]
                    || bounds[2] > window[2] || bounds[3] > window[3] / 4)
                throw new IllegalStateException("works tab outside header");
            boolean dataCenter = false;
            NativeNavigationAction.Node parent = n;
            for (int i = 0; i < 8; i++) {
                parent = parent.parent();
                if (parent == null) break;
                all.add(parent);
                if (!"com.xingin.xhs".equals(parent.value("package"))) throw new IllegalStateException("foreign parent");
                if ("android.webkit.WebView".equals(parent.value("class")) && "数据中心".equals(parent.value("text"))) {
                    dataCenter = true; break;
                }
            }
            if (!dataCenter || !n.click())
                throw new IllegalStateException("works tab action failed");
        } finally {
            for (NativeNavigationAction.Node n : all) n.close();
            r.close();
        }
    }
    public static void main(String[] args) {
        Object wrapper = null; boolean connected = false; int code = 1;
        StringBuilder out = new StringBuilder("<works-session diagnostic-only=\"true\">");
        try {
            if (args.length != 0) throw new IllegalArgumentException("no arguments");
            wrapper = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            NativeTreeAudit.call(wrapper, "connect"); connected = true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            Object automation = NativeTreeAudit.call(wrapper, "getUiAutomation");
            Object root = NativeNavigationAction.freshRoot(() -> NativeTreeAudit.call(automation, "getRootInActiveWindow"));
            open(root); out.append("<action completed=\"true\"/>");
            // No action retries, swipes or clicks inside posts.
            for (int i = 0; i < 3; i++) {
                Thread.sleep(i == 0 ? 1000 : 2000);
                Object snapshot = NativeTreeAudit.call(automation, "getRootInActiveWindow");
                NativeTreeAudit.Audit audit = new NativeTreeAudit.Audit();
                out.append("<snapshot index=\"").append(i).append("\">");
                out.append(audit.read(snapshot == null ? null : new NativeTreeAudit.FreshNode(snapshot)));
                out.append("<summary visited=\"").append(audit.visited).append("\" missing=\"").append(audit.missing).append("\"/></snapshot>");
            }
            out.append("</works-session>"); code = 0;
        } catch (Exception e) {
            System.err.println("works_session_unproven:" + e.getClass().getSimpleName() + ":" + e.getMessage());
        } finally {
            if (connected) try { NativeTreeAudit.call(wrapper, "disconnect"); } catch (Exception e) { code = 1; }
        }
        if (code == 0) System.out.print(out);
        System.exit(code);
    }
}
