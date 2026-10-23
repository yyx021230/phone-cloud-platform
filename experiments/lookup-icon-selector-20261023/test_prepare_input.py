import unittest,tempfile,subprocess,json,hashlib,sys
from pathlib import Path
from PIL import Image
class PrepareTests(unittest.TestCase):
 def run_case(self,boxes):
  with tempfile.TemporaryDirectory() as td:
   d=Path(td);image=d/'sample.png';Image.new('RGB',(720,520),'white').save(image)
   rows=[{'file':'sample.png','size':[720,520],'imageSha256':hashlib.sha256(image.read_bytes()).hexdigest(),'boxes':[{'box':b,'score':.4} for b in boxes]}]
   (d/'in.json').write_text(json.dumps(rows));subprocess.run([sys.executable,str(Path(__file__).with_name('prepare-input.py')),'--detections',str(d/'in.json'),'--images',str(d),'--out',str(d/'out')],check=True,capture_output=True)
   return json.loads((d/'out/inputs.json').read_text())[0]
 def test_zero_area_padding_box_removed_without_renumbering(self):
  r=self.run_case([[10,20,30,40],[.3,520,346,520],[40,50,60,70]])
  self.assertEqual([x['id'] for x in r['candidates']],['b0','b2']);self.assertEqual(r['discarded'],[{'id':'b1','reason':'invalid_or_degenerate_box'}])
 def test_reversed_nonfinite_and_outside_boxes_do_not_reach_image_or_model(self):
  r=self.run_case([[10,20,5,40],[0,0,float('nan'),30],[-1,0,20,30],[0,0,721,40]])
  self.assertEqual(r['candidates'],[]);self.assertEqual(len(r['discarded']),4)
 def test_valid_edge_box_preserved(self):
  r=self.run_case([[690,490,720,520]]);self.assertEqual(r['candidates'][0]['box'],[690,490,720,520]);self.assertEqual(r['discarded'],[])
if __name__=='__main__':unittest.main()
