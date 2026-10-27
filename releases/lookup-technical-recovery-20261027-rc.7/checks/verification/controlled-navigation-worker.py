
import sys,pathlib,runpy
scripts=pathlib.Path(__file__).parent/'scripts'
sys.path.insert(0,str(scripts))
import alipay_name_lookup as lookup
original=lookup.Runner.poco_try_reuse_search_page
def navigation(self,poco):
    if self.payload.get('_faultAcceptanceBeforeInput') is True:
        self.emit('test_injected_navigation_read_timeout',controlledFault=True,beforeInput=True)
        raise RuntimeError("poco_rpc_failed:HTTPConnectionPool(host='127.0.0.1', port=1): Read timed out. (read timeout=2.0)")
    return original(self,poco)
lookup.Runner.poco_try_reuse_search_page=navigation
tap=lookup.Runner.poco_tap
def diagnostic_tap(self,node,deadline=None):
    if self.poco_text(node)=='刷新':
        x,y=node.get_position();w,h=self.display_size(timeout=2)
        self.emit('test_network_refresh_target',normalized=[x,y],screenSize=[w,h],pixel=[round(x*w),round(y*h)])
    return tap(self,node,deadline=deadline)
lookup.Runner.poco_tap=diagnostic_tap
runpy.run_path(str(scripts/'xhs_airtest_poco.py'),run_name='__main__')
