/** Bounded element-only snapshot with exact WebView node IDs routed to the active window. */
public final class NativeWindowReader {
    static final String PKG = "com.xingin.xhs";
    interface Info extends NativeElementsProbe.Node {
        int window() throws Exception;
        int connection() throws Exception;
        long id() throws Exception;
        long childId(int index) throws Exception;
        Info child(int index) throws Exception;
    }
    interface Backend {
        Info root() throws Exception;
        Info fetch(int connection, int window, long id) throws Exception;
    }
    static final class Context {
        final Backend backend;
        final int window, connection;
        final long rootId;
        final long deadline = System.nanoTime() + 12_000_000_000L;
        int requests, corrected;
        Context(Backend backend, Info root) throws Exception {
            this.backend=backend; window=root.window(); connection=root.connection(); rootId=root.id();
            if(window<0 || connection<0 || !PKG.equals(root.value("package")))
                throw new IllegalStateException("unproven native root identity");
        }
        void check(Info node, long expected) throws Exception {
            if(node.id()!=expected || node.connection()!=connection || !PKG.equals(node.value("package")))
                throw new IllegalStateException("native node identity mismatch");
        }
        Info fetch(long id) throws Exception {
            if(++requests>2500 || System.nanoTime()>deadline)throw new IllegalStateException("native request budget exceeded");
            Info node=backend.fetch(connection,window,id);
            if(node==null)throw new IllegalStateException("native child missing; snapshot incomplete");
            try { check(node,id); return node; }
            catch(Exception e){node.close();throw e;}
        }
        NativeElementsProbe.Node wrap(Info original, long host, boolean fetched) throws Exception {
            Info node=original;
            try {
                check(node,node.id());
                if(node.window()!=window) {
                    if(node.window()<0 || host<0 || (node.id()&0xffffffffL)!=host)
                        throw new IllegalStateException("foreign native window outside proven WebView");
                    // Cached text/bounds/children may also be stale: refresh every such node,
                    // not only missing children. Some providers retain the old window in replies.
                    if(!fetched) {
                        Info fresh=fetch(node.id()); node.close(); node=fresh;
                        if(node.window()<0 || (node.id()&0xffffffffL)!=host)
                            throw new IllegalStateException("unproven refreshed WebView node");
                    }
                    corrected++;
                }
                return new Routed(node,host,this);
            } catch(Exception e){node.close();throw e;}
        }
        void verifyRoot() throws Exception {
            Info last=backend.root();
            if(last==null)throw new IllegalStateException("native root disappeared");
            try {
                check(last,rootId);
                if(last.window()!=window)throw new IllegalStateException("native active window changed");
            } finally {last.close();}
        }
    }
    static final class Routed implements NativeElementsProbe.Node {
        final Info node; final long host; final Context context;
        Routed(Info node,long host,Context context){this.node=node;this.host=host;this.context=context;}
        public boolean visible() throws Exception{return node.visible();}
        public int children() throws Exception{return node.children();}
        public String value(String key) throws Exception{return node.value(key);}
        public void close() throws Exception{node.close();}
        public NativeElementsProbe.Node child(int index) throws Exception {
            long childHost="android.webkit.WebView".equals(node.value("class")) ? node.id()&0xffffffffL : host;
            long id=node.childId(index);
            boolean fetch=node.window()!=context.window;
            if(fetch && (childHost<0 || (id&0xffffffffL)!=childHost))
                throw new IllegalStateException("foreign native child outside proven WebView");
            Info child=fetch ? context.fetch(id) : node.child(index);
            if(child==null){child=context.fetch(id);fetch=true;}
            try { context.check(child,id); }
            catch(Exception e){child.close();throw e;}
            return context.wrap(child,childHost,fetch);
        }
    }
    static String read(Backend backend) throws Exception {
        Info root=backend.root();
        if(root==null)throw new IllegalStateException("native root missing");
        Context context;
        try {context=new Context(backend,root);}
        catch(Exception e){root.close();throw e;}
        String xml=new NativeElementsProbe.Reader().read(context.wrap(root,-1,false));
        context.verifyRoot();
        return xml.replace("<hierarchy data-source=\"xml\">", "<hierarchy data-source=\"xml\" native-window-reader=\"1\" corrected-nodes=\""+context.corrected+"\">");
    }
    static final class AndroidInfo implements Info {
        final Object raw; final NativeElementsProbe.AndroidNode node;
        AndroidInfo(Object raw){this.raw=raw;node=new NativeElementsProbe.AndroidNode(raw);}
        public int window() throws Exception{return (Integer)NativeElementsProbe.call(raw,"getWindowId");}
        public int connection() throws Exception{return (Integer)NativeElementsProbe.call(raw,"getConnectionId");}
        public long id() throws Exception{return (Long)NativeElementsProbe.call(raw,"getSourceNodeId");}
        public long childId(int i) throws Exception{return (Long)raw.getClass().getMethod("getChildId",int.class).invoke(raw,i);}
        public Info child(int i) throws Exception{Object v=raw.getClass().getMethod("getChild",int.class).invoke(raw,i);return v==null?null:new AndroidInfo(v);}
        public boolean visible() throws Exception{return node.visible();}
        public int children() throws Exception{return node.children();}
        public String value(String key) throws Exception{return node.value(key);}
        public void close() throws Exception{node.close();}
    }
    static final class AndroidBackend implements Backend {
        final Object automation, client; final Class<?> clientClass;
        AndroidBackend(Object automation) throws Exception {
            this.automation=automation;
            clientClass=Class.forName("android.view.accessibility.AccessibilityInteractionClient");
            client=clientClass.getMethod("getInstance").invoke(null);
        }
        public Info root() throws Exception {
            // This process's accessibility client cache only; no server/settings changes.
            clientClass.getMethod("clearCache").invoke(client);
            Object root=NativeElementsProbe.call(automation,"getRootInActiveWindow");
            return root==null?null:new AndroidInfo(root);
        }
        public Info fetch(int connection,int window,long id) throws Exception {
            Object raw=clientClass.getMethod("findAccessibilityNodeInfoByAccessibilityId",
                int.class,int.class,long.class,boolean.class,int.class,Class.forName("android.os.Bundle"))
                .invoke(client,connection,window,id,true,0,null);
            return raw==null?null:new AndroidInfo(raw);
        }
    }
    public static void main(String[] args) {
        Object wrapper=null; boolean connected=false; String xml=null; int code=1;
        try {
            if(args.length!=0)throw new IllegalArgumentException("no arguments accepted");
            wrapper=Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            NativeElementsProbe.call(wrapper,"connect");connected=true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy",boolean.class).invoke(wrapper,false);
            Thread.sleep(2000);
            xml=read(new AndroidBackend(NativeElementsProbe.call(wrapper,"getUiAutomation")));code=0;
        } catch(Exception e){System.err.println("native_elements_unproven:"+e.getClass().getSimpleName()+":"+e.getMessage());}
        finally {
            if(connected)try{NativeElementsProbe.call(wrapper,"disconnect");}
            catch(Exception e){code=1;System.err.println("native_disconnect_failed");}
        }
        if(code==0)System.out.print(xml);
        System.exit(code);
    }
}
