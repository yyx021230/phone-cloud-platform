import java.util.*;
public final class NativeNavigationActionTest {
 static class N implements NativeNavigationAction.Node {
  Map<String,String> fields=new HashMap<>();List<N> kids=new ArrayList<>();boolean visible=true,refresh=true,accepted=true,closed;int clicks;N parent,focus;Map<String,List<NativeNavigationAction.Node>> queries=new HashMap<>();
  N(String type,String desc){fields.put("class",type);fields.put("desc",desc);fields.put("package","com.xingin.xhs");fields.put("clickable","true");fields.put("enabled","true");fields.put("selected","false");}
  public String value(String k){return fields.getOrDefault(k,"");}public boolean visible(){return visible;}public int children(){return kids.size();}public NativeNavigationAction.Node child(int i){return kids.get(i);}public boolean refresh(){return refresh;}public List<NativeNavigationAction.Node> query(String t){return queries.getOrDefault(t,Collections.emptyList());}public NativeNavigationAction.Node parent(){return parent;}public NativeNavigationAction.Node inputFocus(){return focus;}public boolean click(){clicks++;return accepted;}public void close(){closed=true;}
 }
 static N tree(){N r=new N("android.widget.FrameLayout","");N row=new N("android.view.ViewGroup","");r.kids.add(row);String[] names={"首页","市集","发布","消息，99+条未读","我"};for(int i=0;i<5;i++)row.kids.add(new N(i==2?"android.widget.RelativeLayout":"android.view.ViewGroup",names[i]));row.kids.get(0).fields.put("selected","true");return r;}
 static void run(N root,String action)throws Exception{try(NativeNavigationAction.Selection s=new NativeNavigationAction.Selection()){s.walk(root,0);s.perform(action);}}
 public static void main(String[] a)throws Exception{
  int count=0;N r=tree();N target=r.kids.get(0).kids.get(4);run(r,"profile");if(target.clicks!=1||!target.closed)throw new AssertionError();count++;
  for(String kind:new String[]{"foreign","duplicate","missing","hidden","disabled","wronglabel","wrongclass","selected","refresh","editor","budget"}){
   r=tree();target=r.kids.get(0).kids.get(4);
   switch(kind){case "foreign":target.fields.put("package","other");break;case "duplicate":r.kids.add(tree().kids.get(0));break;case "missing":r.kids.add(null);break;case "hidden":target.visible=false;break;case "disabled":target.fields.put("enabled","false");break;case "wronglabel":target.fields.put("desc","发送");break;case "wrongclass":target.fields.put("class","android.widget.Button");break;case "selected":target.fields.put("selected","true");break;case "refresh":target.refresh=false;break;case "editor":N e=new N("android.widget.EditText","");e.fields.put("focused","true");r.kids.add(e);break;case "budget":for(int i=0;i<2001;i++)r.kids.add(new N("android.view.View",""));break;}
   boolean failed=false;try{run(r,"profile");}catch(IllegalStateException expected){failed=true;}if(!failed||target.clicks!=0)throw new AssertionError(kind);count++;
  }
  r=tree();target=r.kids.get(0).kids.get(4);target.fields.put("selected","true");N menu=new N("android.widget.ImageView","菜单");r.kids.add(menu);run(r,"menu");if(menu.clicks!=1)throw new AssertionError();count++;
  r=tree();menu=new N("android.widget.ImageView","菜单");r.kids.add(menu);boolean failed=false;try{run(r,"menu");}catch(IllegalStateException e){failed=true;}if(!failed||menu.clicks!=0)throw new AssertionError();count++;
  r=tree();target=r.kids.get(0).kids.get(4);target.parent=r.kids.get(0);r.queries.put("我",Arrays.asList(target));r.kids.add(null);
  try(NativeNavigationAction.Selection s=new NativeNavigationAction.Selection()){s.queryNavigation(r,"profile");s.perform("profile");}if(target.clicks!=1)throw new AssertionError("irrelevant feed child blocked native query");count++;
  r=tree();target=r.kids.get(0).kids.get(4);target.parent=r.kids.get(0);target.parent.kids.set(1,null);r.queries.put("我",Arrays.asList(target));failed=false;
  try(NativeNavigationAction.Selection s=new NativeNavigationAction.Selection()){s.queryNavigation(r,"profile");s.perform("profile");}catch(IllegalStateException e){failed=true;}if(!failed||target.clicks!=0)throw new AssertionError("incomplete footer accepted");count++;
  System.out.println("NativeNavigationAction tests passed: "+count);
 }
}
