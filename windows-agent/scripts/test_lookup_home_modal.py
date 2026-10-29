import unittest
from lookup_home_modal import optional_home_modal


def row(text, x, y, score=.99):
    return [[[x-80,y-15],[x+80,y-15],[x+80,y+15],[x-80,y+15]], text, score]


class OptionalModalTests(unittest.TestCase):
    def rows(self, kind='real_name'):
        if kind == 'real_name':
            return [row('仅需两步完成实名认证',360,630),row('信息填写',250,800),
                    row('身份认证',470,800),row('下一步',360,1020)]
        return [row('20元通用和闪购券包',360,630),
                row('网上购物、外卖到店都能用',360,870),row('去领取',360,1020)]

    def test_closed_set_modal_and_center_circle(self):
        for kind in ['real_name','coupon']:
            self.assertEqual(optional_home_modal(self.rows(kind),(720,1600),(360,1250)),kind)

    def test_title_only_or_action_only_is_not_proof(self):
        for rows in [self.rows()[:1],self.rows()[1:],self.rows()[:-1]]:
            self.assertIsNone(optional_home_modal(rows,(720,1600),(360,1250)))

    def test_unrelated_close_banner_or_unstable_text_rejected(self):
        for close in [(650,1300),(360,500),None]:
            self.assertIsNone(optional_home_modal(self.rows(),(720,1600),close))
        for extra in [row('安全验证',360,500),row('下一步',360,1050)]:
            self.assertIsNone(optional_home_modal(self.rows()+[extra],(720,1600),(360,1250)))
        rows=self.rows();rows[0][2]=.8
        self.assertIsNone(optional_home_modal(rows,(720,1600),(360,1250)))

    def test_title_on_wrong_page_layout_never_authorizes_close(self):
        rows=self.rows();rows[-1]=row('下一步',600,1020)
        self.assertIsNone(optional_home_modal(rows,(720,1600),(360,1250)))
        rows=self.rows();rows[0]=row('仅需两步完成实名认证',360,1400)
        self.assertIsNone(optional_home_modal(rows,(720,1600),(360,1250)))

if __name__=='__main__':unittest.main()
