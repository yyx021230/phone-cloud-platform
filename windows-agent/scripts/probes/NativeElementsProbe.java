import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Diagnostic only: a bounded native hierarchy read; no screenshots or inputs. */
public final class NativeElementsProbe {
    interface Node {
        boolean visible() throws Exception;
        int children() throws Exception;
        Node child(int i) throws Exception;
        String value(String name) throws Exception;
        void close() throws Exception;
    }
    static final String[] ATTRS = {"text", "resource-id", "class", "package", "content-desc",
        "checkable", "checked", "clickable", "enabled", "focusable", "focused",
        "scrollable", "long-clickable", "password", "selected", "bounds"};
    static final String[] METHODS = {"getText", "getViewIdResourceName", "getClassName", "getPackageName", "getContentDescription",
        "isCheckable", "isChecked", "isClickable", "isEnabled", "isFocusable", "isFocused",
        "isScrollable", "isLongClickable", "isPassword", "isSelected"};
    static Object call(Object o, String method) throws Exception {
        return o.getClass().getMethod(method).invoke(o);
    }
    static final class AndroidNode implements Node {
        final Object node;
        AndroidNode(Object node) { this.node = node; }
        public boolean visible() throws Exception { return (Boolean) call(node, "isVisibleToUser"); }
        public int children() throws Exception { return (Integer) call(node, "getChildCount"); }
        public Node child(int i) throws Exception {
            Object child = node.getClass().getMethod("getChild", int.class).invoke(node, i);
            return child == null ? null : new AndroidNode(child);
        }
        public String value(String name) throws Exception {
            if (name.equals("bounds")) {
                Class<?> type = Class.forName("android.graphics.Rect");
                Object rect = type.getConstructor().newInstance();
                node.getClass().getMethod("getBoundsInScreen", type).invoke(node, rect);
                return String.valueOf(call(rect, "toShortString"));
            }
            for (int i = 0; i < METHODS.length; i++) {
                if (ATTRS[i].equals(name)) {
                    Object value = call(node, METHODS[i]);
                    return value == null ? "" : value.toString();
                }
            }
            throw new IllegalArgumentException("unknown attribute");
        }
        public void close() throws Exception { call(node, "recycle"); }
    }
    static String escaped(String value) {
        StringBuilder s = new StringBuilder();
        value.codePoints().forEach(c -> {
            if (c == '&') s.append("&amp;");
            else if (c == '<') s.append("&lt;");
            else if (c == '>') s.append("&gt;");
            else if (c == '"') s.append("&quot;");
            else if (c == '\n') s.append("&#10;");
            else if (c == '\r') s.append("&#13;");
            else if (c == '\t') s.append("&#9;");
            else if (c < 32 || (c >= 0xd800 && c <= 0xdfff) || c == 0xfffe || c == 0xffff)
                throw new IllegalArgumentException("invalid XML character");
            else s.appendCodePoint(c);
        });
        return s.toString();
    }
    static final class Reader {
        final long deadline = System.nanoTime() + 12_000_000_000L;
        int visited;
        int[] clip;
        static int[] box(String value) {
            Matcher m = Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").matcher(value);
            if (!m.matches()) throw new IllegalStateException("invalid native bounds");
            return new int[]{Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)), Integer.parseInt(m.group(4))};
        }
        String clipped(String value) {
            int[] b = box(value);
            int l = Math.max(clip[0], b[0]), t = Math.max(clip[1], b[1]);
            int r = Math.min(clip[2], b[2]), bottom = Math.min(clip[3], b[3]);
            return l >= r || t >= bottom ? "[0,0][0,0]" : "["+l+","+t+"]["+r+","+bottom+"]";
        }
        final StringBuilder xml = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy data-source=\"xml\">");
        void visit(Node node, int depth, int index) throws Exception {
            if (node == null) throw new IllegalStateException("native child missing; snapshot incomplete");
            try {
                if (++visited > 2500 || depth > 80 || System.nanoTime() > deadline || xml.length() > 1_000_000)
                    throw new IllegalStateException("native snapshot bound exceeded");
                // Do not recurse through invisible subtrees for the stock NAF annotation.
                if (!node.visible()) return;
                xml.append("<node index=\"").append(index).append("\" visible-to-user=\"true\"");
                for (String attr : ATTRS) {
                    String value = node.value(attr);
                    xml.append(' ').append(attr).append("=\"").append(escaped(attr.equals("bounds") ? clipped(value) : value)).append('"');
                    if (xml.length() > 1_000_000) throw new IllegalStateException("native snapshot size bound exceeded");
                }
                xml.append('>');
                int count = node.children();
                if (count < 0 || count > 2500) throw new IllegalStateException("native child count invalid");
                for (int i = 0; i < count; i++) visit(node.child(i), depth + 1, i);
                xml.append("</node>");
            } finally { node.close(); }
        }
        String read(Node root) throws Exception {
            if (root == null) throw new IllegalStateException("native root missing");
            if (!"com.xingin.xhs".equals(root.value("package"))) {
                root.close(); throw new IllegalStateException("foreground package is not XHS");
            }
            clip = box(root.value("bounds"));
            clip[0] = Math.max(0, clip[0]); clip[1] = Math.max(0, clip[1]);
            if (clip[2] <= clip[0] || clip[3] <= clip[1] || clip[2] > 10000 || clip[3] > 10000) {
                root.close(); throw new IllegalStateException("native window bounds unavailable");
            }
            visit(root, 0, 0);
            if (xml.indexOf("<node ") < 0) throw new IllegalStateException("native root invisible");
            return xml.append("</hierarchy>").toString();
        }
    }
    interface RootSource { Node root() throws Exception; }
    static String readFresh(RootSource source, int attempts) throws Exception {
        for (int i = 0; i < attempts; i++) {
            try { return new Reader().read(source.root()); }
            catch (IllegalStateException error) {
                String reason = error.getMessage();
                if (i + 1 == attempts || !(reason.startsWith("native child missing") || reason.equals("native root missing"))) throw error;
                Thread.sleep(300);
            }
        }
        throw new IllegalArgumentException("no native read attempts");
    }
    public static void main(String[] args) {
        Object wrapper = null;
        boolean connected = false;
        int code = 1;
        String xml = null;
        try {
            if (args.length != 0) throw new IllegalArgumentException("no arguments accepted");
            wrapper = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            call(wrapper, "connect"); connected = true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            Object automation = call(wrapper, "getUiAutomation");
            xml = readFresh(() -> {
                Object root = call(automation, "getRootInActiveWindow");
                if (root == null) return null;
                if (!(Boolean) call(root, "refresh")) { call(root, "recycle"); return null; }
                return new AndroidNode(root);
            }, 3);
            code = 0;
        } catch (Exception error) {
            System.err.println("native_elements_unproven:" + error.getClass().getSimpleName() + ":" + error.getMessage());
        } finally {
            if (connected) try { call(wrapper, "disconnect"); }
            catch (Exception error) { code = 1; System.err.println("native_disconnect_failed"); }
        }
        // Emit a hierarchy only after traversal and cleanup both succeed.
        if (code == 0) System.out.print(xml);
        System.exit(code);
    }
}
