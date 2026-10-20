import java.util.*;

/** Bounded native accessibility navigation: only the XHS own-profile tab/menu. */
public final class NativeNavigationAction {
    interface Node {
        String value(String key) throws Exception;
        boolean visible() throws Exception;
        int children() throws Exception;
        Node child(int i) throws Exception;
        boolean refresh() throws Exception;
        List<Node> query(String text) throws Exception;
        Node parent() throws Exception;
        Node inputFocus() throws Exception;
        boolean click() throws Exception;
        void close() throws Exception;
    }
    static final class AndroidNode implements Node {
        final Object n;
        AndroidNode(Object n) { this.n=n; }
        Object call(String method) throws Exception { return n.getClass().getMethod(method).invoke(n); }
        public String value(String key) throws Exception {
            String m;
            switch(key) {
                case "package":m="getPackageName";break;
                case "class":m="getClassName";break;
                case "desc":m="getContentDescription";break;
                case "text":m="getText";break;
                case "clickable":m="isClickable";break;
                case "enabled":m="isEnabled";break;
                case "selected":m="isSelected";break;
                case "focused":m="isFocused";break;
                default:throw new IllegalArgumentException("unknown field");
            }
            Object v=call(m);return v==null?"":v.toString();
        }
        public boolean visible() throws Exception {return (Boolean)call("isVisibleToUser");}
        public int children() throws Exception {return (Integer)call("getChildCount");}
        public Node child(int i) throws Exception {Object c=n.getClass().getMethod("getChild",int.class).invoke(n,i);return c==null?null:new AndroidNode(c);}
        public boolean refresh() throws Exception {return (Boolean)call("refresh");}
        public List<Node> query(String text) throws Exception {
            List<?> found=(List<?>)n.getClass().getMethod("findAccessibilityNodeInfosByText",String.class).invoke(n,text);
            List<Node> out=new ArrayList<>();for(Object item:found)out.add(new AndroidNode(item));return out;
        }
        public Node parent() throws Exception {Object p=call("getParent");return p==null?null:new AndroidNode(p);}
        public Node inputFocus() throws Exception {Object f=n.getClass().getMethod("findFocus",int.class).invoke(n,1);return f==null?null:new AndroidNode(f);}
        public boolean click() throws Exception {return (Boolean)n.getClass().getMethod("performAction",int.class).invoke(n,16);}
        public void close() throws Exception {call("recycle");}
    }
    static final class Selection implements AutoCloseable {
        final List<Node> all=new ArrayList<>();
        final Map<Node,List<Node>> children=new IdentityHashMap<>();
        final long deadline=System.nanoTime()+8_000_000_000L;
        void walk(Node n,int depth) throws Exception {
            if(n==null)throw new IllegalStateException("missing native child");
            all.add(n);
            if(all.size()>2000||depth>60||System.nanoTime()>deadline)throw new IllegalStateException("native read budget");
            if(!"com.xingin.xhs".equals(n.value("package")))throw new IllegalStateException("foreign package");
            if(!n.visible())return;
            int count=n.children();if(count<0||count>2000)throw new IllegalStateException("child budget");
            List<Node> cs=new ArrayList<>();children.put(n,cs);
            for(int i=0;i<count;i++){Node child=n.child(i);cs.add(child);walk(child,depth+1);}
        }
        void queryNavigation(Node root,String action) throws Exception {
            if(root==null)throw new IllegalStateException("missing native root");
            all.add(root);
            if(!"com.xingin.xhs".equals(root.value("package"))||!root.visible())throw new IllegalStateException("foreign or hidden root");
            Node focused=root.inputFocus();if(focused!=null)all.add(focused);
            List<Node> me=root.query("我");if(me.size()>100)throw new IllegalStateException("query budget");
            all.addAll(me);List<Node> matches=new ArrayList<>();
            for(Node n:me)if("com.xingin.xhs".equals(n.value("package"))&&"android.view.ViewGroup".equals(n.value("class"))&&label(n,"我")&&actionable(n))matches.add(n);
            if(matches.size()!=1)throw new IllegalStateException("profile query is ambiguous");
            if(action.equals("profile")){
                // Feed children are irrelevant to this navigation proof. The
                // complete five-item footer must still be traversable.
                walk(matches.get(0).parent(),0);
            }else if(action.equals("menu")){
                List<Node> menus=root.query("菜单");if(menus.size()>100)throw new IllegalStateException("query budget");all.addAll(menus);
            }else throw new IllegalArgumentException("unsupported action");
            for(Node n:all)if(!"com.xingin.xhs".equals(n.value("package")))throw new IllegalStateException("foreign query node");
        }
        boolean label(Node n,String s) throws Exception {return n.visible()&&(s.equals(n.value("desc"))||s.equals(n.value("text")));}
        boolean actionable(Node n) throws Exception {return n.visible()&&"true".equals(n.value("clickable"))&&"true".equals(n.value("enabled"));}
        Node find(String action) throws Exception {
            if(!action.equals("profile")&&!action.equals("menu"))throw new IllegalArgumentException("unsupported action");
            List<Node> targets=new ArrayList<>();boolean selectedMe=false;
            for(Node n:all){
                if(n.visible()&&n.value("class").contains("EditText")&&"true".equals(n.value("focused")))throw new IllegalStateException("focused editor");
                if(label(n,"我")&&"android.view.ViewGroup".equals(n.value("class"))&&actionable(n)&&"true".equals(n.value("selected")))selectedMe=true;
                if(action.equals("menu")&&label(n,"菜单")&&"android.widget.ImageView".equals(n.value("class"))&&actionable(n))targets.add(n);
            }
            if(action.equals("menu")){
                if(!selectedMe||targets.size()!=1)throw new IllegalStateException("own profile menu unproven");
                return targets.get(0);
            }
            String[] names={"首页","市集","发布","消息","我"};
            for(List<Node> cs:children.values()){
                if(cs.size()!=5)continue;boolean match=true;
                for(int i=0;i<5;i++){
                    Node n=cs.get(i);String desc=n.value("desc").split("，",2)[0];
                    if(!names[i].equals(desc)||!actionable(n)||!(i==2?"android.widget.RelativeLayout":"android.view.ViewGroup").equals(n.value("class")))match=false;
                }
                if(match&&"true".equals(cs.get(0).value("selected"))&&"false".equals(cs.get(4).value("selected")))targets.add(cs.get(4));
            }
            if(targets.size()!=1)throw new IllegalStateException("own profile footer unproven");
            return targets.get(0);
        }
        void perform(String action) throws Exception {
            Node n=find(action);if(System.nanoTime()>deadline||!n.refresh()||!actionable(n)||find(action)!=n)throw new IllegalStateException("target changed");
            if(!n.click())throw new IllegalStateException("native action rejected");
        }
        public void close() throws Exception {Exception failure=null;for(Node n:all)try{n.close();}catch(Exception e){failure=e;}if(failure!=null)throw failure;}
    }
    interface RootSource {Object get() throws Exception;}
    static Object freshRoot(RootSource source) throws Exception {
        for(int i=0;i<3;i++) {Object root=source.get();if(root!=null)return root;if(i<2)Thread.sleep(300);}
        throw new IllegalStateException("missing native root after bounded readback");
    }
    public static void main(String[] args){
        Object wrapper=null;boolean connected=false;int code=1;
        try{
            if(args.length!=1||(!args[0].equals("profile")&&!args[0].equals("menu")))throw new IllegalArgumentException("explicit navigation only");
            wrapper=Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper").getConstructor().newInstance();
            wrapper.getClass().getMethod("connect").invoke(wrapper);connected=true;
            wrapper.getClass().getMethod("setCompressedLayoutHierarchy",boolean.class).invoke(wrapper,false);
            Object automation=wrapper.getClass().getMethod("getUiAutomation").invoke(wrapper);
            try {automation.getClass().getMethod("waitForIdle",long.class,long.class).invoke(automation,300L,2000L);}
            catch(java.lang.reflect.InvocationTargetException e){if(!(e.getCause() instanceof java.util.concurrent.TimeoutException))throw e;}
            Object root=freshRoot(()->automation.getClass().getMethod("getRootInActiveWindow").invoke(automation));
            try(Selection selection=new Selection()){
                selection.queryNavigation(root==null?null:new AndroidNode(root),args[0]);selection.perform(args[0]);
            }
            code=0;
        }catch(Exception e){System.err.println("native_navigation_unproven:"+e.getClass().getSimpleName()+":"+e.getMessage());}
        finally{if(connected)try{wrapper.getClass().getMethod("disconnect").invoke(wrapper);}catch(Exception e){code=1;System.err.println("native_disconnect_failed");}}
        if(code==0)System.out.print("native_navigation_action_completed");System.exit(code);
    }
}
