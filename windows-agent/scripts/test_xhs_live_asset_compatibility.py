"""Actual production collector/cache combinations with additive versioned assets.

All ADB callbacks are fakes. Old fixed JAR bytes must stay unchanged throughout.
"""
import hashlib,importlib.util,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
S=Path(__file__).parent
ROOT=S.parents[1]
OLD=ROOT/'releases/xhs-compat-recovery-20261104-rc.10/rollback/scripts'
WEB='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
INDEX='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
XML=b'<hierarchy data-source="xml" native-window-reader="1"><node package="com.xingin.xhs" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]"/></hierarchy>'
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
class LiveAssetCompatibility(unittest.TestCase):
 def layout(self,base):
  scripts=Path(base)/'scripts';native=scripts/'native';native.mkdir(parents=True)
  for f in ['小红书数据同步.py','xhs_native_window.py','xhs_native_navigation.py']:shutil.copyfile(OLD/f,scripts/f)
  for kind in ['window','pair']:shutil.copyfile(OLD/'native'/('xhs-native-'+kind+'.jar'),native/('xhs-native-'+kind+'.jar'))
  shutil.copyfile(S/'fixtures/xhs/legacy-native-navigation-910f03a9.jar',native/'xhs-native-navigation.jar')
  hashes={p.name:digest(p) for p in native.iterdir()}
  self.assertEqual(hashes['xhs-native-navigation.jar'],'910f03a9c4cd6963b89ce1dd4bf4a6ad21b6f888029970401134fdcf820af754')
  return scripts,hashes
 def publish_scripts(self,scripts):
  for kind in ['window','pair','navigation']:
   src=S/'native'/('xhs-native-'+kind+'.jar');target=scripts/'native'/('xhs-native-'+kind+'-'+digest(src)+'.jar');target.write_bytes(src.read_bytes())
  for name in ['xhs_native_window.py','xhs_native_navigation.py','小红书数据同步.py']:
   temp=scripts/(name+'.new');temp.write_bytes((S/name).read_bytes());temp.replace(scripts/name)
 def exercise_old(self,collector,window,nav):
  pushes=[];current=[WEB]
  def run(adb,serial,*args,**kw):
   self.assertEqual((adb,serial),('SDK/adb.exe','serial'))
   if args[0]=='push':
    p=Path(args[1]);pushes.append((p.name,digest(p)));return subprocess.CompletedProcess(args,0,b'',b'')
   if args[:2]==('shell','ls'):return subprocess.CompletedProcess(args,1,b'',b'No such file or directory')
   if len(args)==2 and args[0]=='shell':
    output=b'native_navigation_action_completed' if 'NativeNavigationAction' in args[1] else b'<native-pair>'+XML+XML+b'</native-pair>' if 'NativeWindowPair' in args[1] else XML
    return subprocess.CompletedProcess(args,0,output,b'')
   return subprocess.CompletedProcess(args,0,b'',b'')
  collector.adb_process=run;collector.focus=lambda *a:current[0];collector.assert_no_poco=lambda *a:None
  events=['collection_slot_requested:app1'];guard=lambda:None
  with patch.dict(sys.modules,{'xhs_native_window':window,'xhs_native_navigation':nav}):
   self.assertEqual(collector.native_window_capture('SDK/adb.exe','serial',WEB,guard,events).tag,'hierarchy')
   self.assertEqual(len(collector.capture_element_pair('SDK/adb.exe','serial',guard,events)),2)
   current[0]=INDEX
   collector.native_index_navigation('profile','SDK/adb.exe','serial',guard,events)
   collector.native_index_navigation('menu','SDK/adb.exe','serial',guard,events)
  return pushes
 def test_four_inflight_old_cache_combinations_use_their_own_pinned_assets(self):
  for cached_window in (False,True):
   for cached_nav in (False,True):
    with self.subTest(cached_window=cached_window,cached_nav=cached_nav),tempfile.TemporaryDirectory() as temp:
     scripts,hashes=self.layout(temp);collector=load('old_running_collector',scripts/'小红书数据同步.py')
     oldw=load('old_running_window',scripts/'xhs_native_window.py');oldn=load('old_running_nav',scripts/'xhs_native_navigation.py')
     old_keys=set(oldw.__dict__);self.publish_scripts(scripts)
     window=oldw if cached_window else load('new_window',scripts/'xhs_native_window.py')
     with patch.dict(sys.modules,{'xhs_native_window':window}):nav=oldn if cached_nav else load('new_nav',scripts/'xhs_native_navigation.py')
     pushes=self.exercise_old(collector,window,nav)
     self.assertEqual(pushes[0][1],window.ASSET_SHA256);self.assertEqual(pushes[1][1],window.PAIR_SHA256)
     self.assertEqual(pushes[2][1],nav.ASSET_SHA256);self.assertEqual(pushes[3][1],nav.ASSET_SHA256)
     self.assertEqual(pushes[0][0],'xhs-native-window.jar' if cached_window else 'xhs-native-window-'+window.ASSET_SHA256+'.jar')
     self.assertEqual(pushes[2][0],'xhs-native-navigation.jar' if cached_nav else 'xhs-native-navigation-'+nav.ASSET_SHA256+'.jar')
     self.assertEqual({name:digest(scripts/'native'/name) for name in hashes},hashes)
     self.assertEqual(set(oldw.__dict__),old_keys) # No replacement of a cached old helper.
 def test_versioned_assets_are_selected_over_fixed_files_but_corruption_never_falls_back(self):
  with tempfile.TemporaryDirectory() as temp:
   scripts,_=self.layout(temp);self.publish_scripts(scripts);w=load('asset_window',scripts/'xhs_native_window.py')
   with patch.dict(sys.modules,{'xhs_native_window':w}):n=load('asset_nav',scripts/'xhs_native_navigation.py')
   self.assertEqual(digest(w.default_asset_path()),w.ASSET_SHA256);self.assertEqual(digest(w.default_asset_path(True)),w.PAIR_SHA256);self.assertEqual(digest(n.default_asset_path()),n.ASSET_SHA256)
   w.default_asset_path().write_bytes(b'corrupt')
   with self.assertRaisesRegex(RuntimeError,'hash mismatch'):w.read('adb','s',lambda *a:None,lambda:WEB,lambda:None,WEB)
 def test_missing_versioned_asset_with_legacy_fixed_bytes_fails_closed(self):
  with tempfile.TemporaryDirectory() as temp:
   scripts,_=self.layout(temp);(scripts/'xhs_native_window.py').write_bytes((S/'xhs_native_window.py').read_bytes());w=load('missing_asset_window',scripts/'xhs_native_window.py')
   with self.assertRaisesRegex(RuntimeError,'hash mismatch'):w.read('adb','s',lambda *a:None,lambda:WEB,lambda:None,WEB)
 def test_legacy_cache_normalizer_still_rejects_other_user_component_and_ambiguous_focus(self):
  with tempfile.TemporaryDirectory() as temp:
   scripts,_=self.layout(temp);oldw=load('cached_window',scripts/'xhs_native_window.py');self.publish_scripts(scripts)
   with patch.dict(sys.modules,{'xhs_native_window':oldw}):nav=load('compatible_nav',scripts/'xhs_native_navigation.py')
   self.assertTrue(nav.same_foreground(INDEX,INDEX.replace('Window{x','Window{different taskId=12')))
   for changed in (INDEX.replace('u0','u999'),WEB,INDEX+'\n'+INDEX,''):
    self.assertFalse(nav.same_foreground(INDEX,changed))
if __name__=='__main__':unittest.main()
