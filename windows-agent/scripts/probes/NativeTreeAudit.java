import java.util.*;

/**
 * Read-only diagnostic. Its partial <audit> output is never a collection result.
 * Records missing native children and query/ancestor evidence without input.
 */
public final class NativeTreeAudit {
    static final String PKG = "com.xingin.xhs";
    static String esc(Object value) {
        return NativeElementsProbe.escaped(value == null ? "" : value.toString());
    }
    static Object call(Object value, String method) throws Exception {
        return NativeElementsProbe.call(value, method);
    }
    static final class Audit {
        final long deadline = System.nanoTime() + 10_000_000_000L;
        int visited, missing;
        final StringBuilder out = new StringBuilder("<tree>");
        void visit(NativeElementsProbe.Node node, int depth, int index) throws Exception {
            if (node == null) {
                out.append("<missing index=\"").append(index).append("\"/>");
                missing++;
                return;
            }
            try {
                if (++visited > 1500 || depth > 60 || System.nanoTime() > deadline || out.length() > 1_000_000)
                    throw new IllegalStateException("audit budget exceeded");
                if (!PKG.equals(node.value("package"))) throw new IllegalStateException("foreign node");
                if (!node.visible()) return;
                out.append("<node index=\"").append(index).append("\"");
                for (String key : NativeElementsProbe.ATTRS)
                    out.append(' ').append(key).append("=\"").append(esc(node.value(key))).append('"');
                out.append('>');
                int count = node.children();
                if (count < 0 || count > 1500) throw new IllegalStateException("audit child count exceeded");
                for (int i = 0; i < count; i++) visit(node.child(i), depth + 1, i);
                out.append("</node>");
            } finally { node.close(); }
        }
        String read(NativeElementsProbe.Node root) throws Exception {
            if (root == null) throw new IllegalStateException("audit root missing");
            visit(root, 0, 0);
            return out.append("</tree>").toString();
        }
    }
    static String ancestors(Object child) throws Exception {
        StringBuilder result = new StringBuilder();
        Object node = child;
        try {
            for (int i = 0; node != null && i < 24; i++) {
                if (!PKG.equals(String.valueOf(call(node, "getPackageName"))))
                    throw new IllegalStateException("query ancestor outside XHS");
                result.append("<ancestor class=\"").append(esc(call(node, "getClassName")))
                    .append("\" text=\"").append(esc(call(node, "getText")))
                    .append("\" child-count=\"").append(call(node, "getChildCount")).append("\"/>");
                Object parent = call(node, "getParent");
                if (node != child) call(node, "recycle");
                node = parent;
            }
        } finally { if (node != null && node != child) call(node, "recycle"); }
        return result.toString();
    }
    public static void main(String[] args) {
        Object wrapper = null, root = null;
        boolean connected = false;
        String result = null;
        int code = 1;
        try {
            if (args.length != 0) throw new IllegalArgumentException("no arguments");
            wrapper = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            call(wrapper, "connect"); connected = true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            Object automation = call(wrapper, "getUiAutomation");
            // WebView may initialize its accessibility provider after connect.
            // Compare this bounded settled read with the immediate-read evidence.
            Thread.sleep(2000);
            for (int i = 0; i < 3 && root == null; i++) {
                root = call(automation, "getRootInActiveWindow");
                if (root == null) Thread.sleep(300);
            }
            if (root == null || !PKG.equals(String.valueOf(call(root, "getPackageName"))))
                throw new IllegalStateException("XHS root required");
            if (!(Boolean)call(root, "refresh")) throw new IllegalStateException("root refresh failed");
            StringBuilder out = new StringBuilder("<audit diagnostic-only=\"true\" settle-ms=\"2000\">");
            for (String label : new String[]{"数据中心", "作品分析", "全部笔记", "观看"}) {
                List<?> found = (List<?>)root.getClass().getMethod("findAccessibilityNodeInfosByText", String.class).invoke(root, label);
                if (found.size() > 100) {
                    for (Object node : found) if (node != null) call(node, "recycle");
                    throw new IllegalStateException("query result budget");
                }
                out.append("<query label=\"").append(label).append("\" count=\"").append(found.size()).append("\">");
                try {
                    for (Object node : found) if (node != null)
                        out.append("<match>").append(ancestors(node)).append("</match>");
                } finally { for (Object node : found) if (node != null) call(node, "recycle"); }
                out.append("</query>");
            }
            Audit audit = new Audit();
            Object owned = root; root = null;
            out.append(audit.read(new NativeElementsProbe.AndroidNode(owned)));
            out.append("<summary visited=\"").append(audit.visited).append("\" missing=\"").append(audit.missing).append("\"/></audit>");
            result = out.toString(); code = 0;
        } catch (Exception error) {
            System.err.println("native_audit_failed:" + error.getClass().getSimpleName() + ":" + error.getMessage());
        } finally {
            if (root != null) try { call(root, "recycle"); } catch (Exception error) { code = 1; }
            if (connected) try { call(wrapper, "disconnect"); } catch (Exception error) { code = 1; }
        }
        if (code == 0) System.out.print(result);
        System.exit(code);
    }
}
