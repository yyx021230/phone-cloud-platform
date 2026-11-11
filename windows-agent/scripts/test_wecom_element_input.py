"""No SDK, process, device or network access."""
import unittest
from wecom_element_input import ElementAdbInput, tap_command
from wecom_invite_preview import StopPreview


class ElementInputTests(unittest.TestCase):
    def test_physical_and_override_must_match_current_poco_dimensions(self):
        self.assertEqual(tap_command(.5,.25,'Physical size: 1080x2400',[1080,2400]),'input tap 540 600')
        self.assertEqual(tap_command(.5,.25,'Physical size: 1080x2400\nOverride size: 720x1600',[720,1600]),'input tap 360 400')
        for raw,size in [('Physical size: 1080x2400',[720,1600]),
                         ('Override size: 720x1600',[720,1600]),
                         ('Physical size: 1080x2400\nPhysical size: 1080x2400',[1080,2400]),
                         ('Error: no display',[1080,2400]),
                         ('Physical size: 1080x2400',[True,2400])]:
            with self.assertRaises(StopPreview):tap_command(.5,.25,raw,size)

    def test_invalid_geometry_never_clamps_to_a_different_target(self):
        for x,y in [(0,.5),(1,.5),(-.1,.5),(float('nan'),.5),(.5,float('inf')),(True,.5)]:
            with self.assertRaises(StopPreview):tap_command(x,y,'Physical size: 1080x2400',[1080,2400])

    def adapter(self,authorizations=(True,True),reply=''):
        calls=[];states=iter(authorizations)
        def authorize():calls.append('authorize');return next(states)
        def shell(command):calls.append(command);return 'Physical size: 1080x2400'
        def size():calls.append('dimensions');return [1080,2400]
        def tap(command):calls.append(command);return reply
        return ElementAdbInput(object(),authorize=authorize,shell=shell,screen_size=size,tap=tap),calls

    def test_authority_checked_before_dimensions_and_immediately_before_tap(self):
        adapter,calls=self.adapter();self.assertTrue(adapter.click(.5,.25))
        self.assertEqual(calls,['authorize','wm size','dimensions','authorize','input tap 540 600'])

    def test_lost_or_unknown_authority_never_taps(self):
        for states in [(False,),(None,),(True,False),(True,None)]:
            adapter,calls=self.adapter(states)
            with self.assertRaises(StopPreview):adapter.click(.5,.25)
            self.assertFalse(any(c.startswith('input tap ')for c in calls))

    def test_unknown_delivery_is_attempted_only_once(self):
        for reply in ['Error: input rejected','Security Exception','Permission Denial','usage: input tap',None]:
            adapter,calls=self.adapter(reply=reply)
            with self.assertRaisesRegex(StopPreview,'wecom_element_tap_delivery_unknown'):adapter.click(.5,.25)
            self.assertEqual(sum(c.startswith('input tap ')for c in calls),1)


if __name__=='__main__':unittest.main()
