import java.util.*;
public final class NativeWindowReaderTest {
 static int tests;
 static class N implements NativeWindowReader.Info {
  int win=10,conn=3,closed;long id;String pkg="com.xingin.xhs",text="",cls="android.view.View";List<N> kids=new ArrayList<>();boolean missing;
  N(long id){this.id=id;}
  public int window(){return win;}public int connection(){return conn;}public long id(){return id;}
  public long childId(int i){return kids.get(i).id;}public N child(int i){return missing?null:kids.get(i);}
  public int children(){return kids.size();}public boolean visible(){return true;}
  public String value(String key){switch(key){case "package":return pkg;case "text":return text;case "class":return cls;case "bounds":return "[0,0][100,100]";default:return "false";}}
  public void close(){closed++;}
 }
 static class B implements NativeWindowReader.Backend {
  N root=new N(1),web=new N(7),stale=new N((2L<<32)|7),fresh=new N((2L<<32)|7),leaf=new N((3L<<32)|7),last=root;int roots,fetches;
  Map<Long,N> replies=new HashMap<>();
  B(){web.cls="android.webkit.WebView";root.kids.add(web);web.kids.add(stale);stale.win=9;stale.text="cached";fresh.win=9;fresh.text="current";fresh.kids.add(leaf);fresh.missing=true;leaf.win=9;leaf.text="row";replies.put(stale.id,fresh);replies.put(leaf.id,leaf);}
  public N root(){return roots++==0?root:last;}
  public N fetch(int conn,int win,long id){if(conn!=3||win!=10)throw new AssertionError("wrong routing");fetches++;return replies.get(id);}
 }
 static void ok(boolean v){if(!v)throw new AssertionError();}
 interface Test {void run() throws Exception;}
 static void reject(Test t,String reason)throws Exception{try{t.run();throw new AssertionError("accepted "+reason);}catch(IllegalStateException e){ok(e.getMessage().contains(reason));}tests++;}
 public static void main(String[] args)throws Exception{
  B b=new B();String xml=NativeWindowReader.read(b);ok(xml.contains("current")&&xml.contains("row")&&!xml.contains("cached"));ok(b.fetches==2&&b.root.closed==2&&b.stale.closed==1&&b.fresh.closed==1&&b.leaf.closed==1);tests++;
  B missing=new B();missing.replies.remove(missing.leaf.id);reject(()->NativeWindowReader.read(missing),"child missing");ok(missing.root.closed==1&&missing.fresh.closed==1);
  B foreign=new B();foreign.web.cls="android.view.View";reject(()->NativeWindowReader.read(foreign),"outside proven WebView");ok(foreign.fetches==0);
  B host=new B();host.stale.id=(2L<<32)|8;reject(()->NativeWindowReader.read(host),"outside proven WebView");
  B conn=new B();conn.fresh.conn=4;reject(()->NativeWindowReader.read(conn),"identity mismatch");ok(conn.fresh.closed==1);
  B identity=new B();identity.fresh.id=100;reject(()->NativeWindowReader.read(identity),"identity mismatch");
  B pkg=new B();pkg.leaf.pkg="com.other";reject(()->NativeWindowReader.read(pkg),"identity mismatch");
  B changed=new B();changed.last=new N(1);changed.last.win=11;reject(()->NativeWindowReader.read(changed),"active window changed");
  B gone=new B();gone.last=null;reject(()->NativeWindowReader.read(gone),"root disappeared");
  B childHost=new B();childHost.leaf.id=(3L<<32)|8;reject(()->NativeWindowReader.read(childHost),"foreign native child");
  B empty=new B();empty.root.kids.clear();ok(NativeWindowReader.read(empty).contains("hierarchy"));tests++;
  B budget=new B();NativeWindowReader.Context context=new NativeWindowReader.Context(budget,budget.root);context.requests=2500;reject(()->context.fetch(budget.fresh.id),"budget exceeded");ok(budget.fetches==0);
  System.out.println(tests+" native window reader tests passed");
 }
}
