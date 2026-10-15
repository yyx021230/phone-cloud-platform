import unittest
from unittest import mock
from types import SimpleNamespace
import alipay_name_lookup as m
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row,PHONE,card
import test_lookup_loading_guard as fixtures
class RemainingCompat(unittest.TestCase):
 def test_exit_255_partial_dump_is_reread_not_trusted(self):
  r=m.Runner({'serial':'SYNTHETIC'});r.emit=mock.Mock()
  a=SimpleNamespace(returncode=255,stdout='mCurrentFocus=Window{old p/.Old}',stderr='')
  b=SimpleNamespace(returncode=0,stdout='mCurrentFocus=Window{new p/.New}',stderr='')
  with mock.patch.object(m.subprocess,'run',side_effect=[a,b]) as run,mock.patch.object(m.time,'sleep'):
   self.assertIn('p/.New',r.focus()[0]);self.assertEqual(run.call_count,2)
 def test_persistent_255_never_trusts_partial_snapshot(self):
  r=m.Runner({'serial':'SYNTHETIC'});r.emit=mock.Mock()
  with mock.patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=255,stdout='mCurrentFocus=Window{a p/.Home}',stderr='')) as run,mock.patch.object(m.time,'sleep'):
   with self.assertRaisesRegex(RuntimeError,'adb_read_unavailable'):r.focus()
   self.assertEqual(run.call_count,4)
 def rows(self):return [row(PHONE,250,121),row('快捷功能',100,337),row('手机充值：'+PHONE,370,449),row('自',678,1333,.969)]
 def test_recharge_without_suggestions_and_clipboard_is_empty(self):
  self.assertTrue(parse_empty_rows(self.rows(),PHONE,(720,1600))['notFound'])
 def test_icon_cannot_hide_unknown_text_name_or_wrong_position(self):
  for rows in [self.rows()+card()[1:],self.rows()+[row('未知内容',350,600)],self.rows()+[row('自',679,1330)],self.rows()[:-1]+[row('自',400,800)]]:
   self.assertIsNone(parse_empty_rows(rows,PHONE,(720,1600)))
 def test_two_frames_and_prepared_proof_still_required(self):
  def setup(r,p):r.payload['preparedEmptyResult']=True
  _,r,_=fixtures.LoadingGuardTests().run_frames([self.rows(),self.rows()],setup=setup)
  self.assertTrue(r['notFound'])
  with self.assertRaisesRegex(RuntimeError,'observation_budget_exhausted'):
   fixtures.LoadingGuardTests().run_frames([self.rows()],budget=3)
if __name__=='__main__':unittest.main()
