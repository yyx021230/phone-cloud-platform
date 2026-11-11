import unittest,runpy,json,copy
from pathlib import Path
helper=runpy.run_path(str(Path(__file__).with_name('compose-preflight.py')))
resolve=helper['existing_xhs_environment']

def row():return {'State':{'Running':True},'Config':{'Image':'fixture:immutable','Labels':{'com.docker.compose.service':'xhs-batch','com.docker.compose.project':'fixture'},'Env':['XHS_BATCH_DATABASE_URL=postgresql://fixture:synthetic-password@fixture/db']},'Mounts':[{'Type':'bind','RW':False,'Source':'/private/fixture.json','Destination':'/run/xhs-batch/config.json'}]}
class Tests(unittest.TestCase):
 def test_reuse_only_actual_three_references_without_mutating_input(self):
  original={'PATH':'fixture-path','UNRELATED':'same'};snapshot=row();before=copy.deepcopy(snapshot)
  env=resolve([snapshot],original,project='fixture',is_file=lambda p:True)
  self.assertEqual(original,{'PATH':'fixture-path','UNRELATED':'same'});self.assertEqual(snapshot,before)
  self.assertEqual(env['XHS_BATCH_IMAGE'],'fixture:immutable');self.assertEqual(env['XHS_BATCH_DATABASE_URL'],snapshot['Config']['Env'][0].split('=',1)[1]);self.assertEqual(env['XHS_BATCH_CONFIG_PATH'],'/private/fixture.json')
 def test_missing_or_ambiguous_container_fails_closed(self):
  for rows in ([],[row(),row()]):
   with self.assertRaises(ValueError):resolve(rows,{},project='fixture',is_file=lambda p:True)
 def test_other_project_or_stopped_container_cannot_supply_credentials(self):
  for field in ('project','running'):
   value=row()
   if field=='project':value['Config']['Labels']['com.docker.compose.project']='other'
   else:value['State']['Running']=False
   with self.assertRaises(ValueError):resolve([value],{},project='fixture',is_file=lambda p:True)
 def test_read_write_or_absent_private_mount_rejected(self):
  value=row();value['Mounts'][0]['RW']=True
  with self.assertRaises(ValueError):resolve([value],{},project='fixture',is_file=lambda p:True)
  with self.assertRaises(ValueError):resolve([row()],{},project='fixture',is_file=lambda p:False)
 def test_unknown_or_duplicate_database_values_rejected(self):
  for values in ([],['XHS_BATCH_DATABASE_URL='],['XHS_BATCH_DATABASE_URL=one','XHS_BATCH_DATABASE_URL=two']):
   value=row();value['Config']['Env']=values
   with self.assertRaises(ValueError):resolve([value],{},project='fixture',is_file=lambda p:True)
if __name__=='__main__':unittest.main()
