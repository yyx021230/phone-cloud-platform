import io
import threading
import unittest
from unittest.mock import patch
import wecom_control_pipe as p

class ControlPipeTests(unittest.TestCase):
    def run_chunks(self,chunks):
        cancelled=threading.Event();stream=iter(chunks);waits=[]
        p.watch(lambda:next(stream),cancelled,wait=lambda n:waits.append(n))
        self.assertTrue(cancelled.is_set());return waits
    def test_no_available_bytes_poll_without_blocking_read(self):
        self.assertEqual(self.run_chunks([None,None,b'can',b'cel\n']),[.05,.05])
    def test_eof_cancel_and_oversized_control_all_stop(self):
        for chunks in ([b''],[b'cancel\n'],[b'can',b'cel\r\n'],[b'x'*64]*17):self.run_chunks(chunks)
    def test_pipe_error_fails_closed(self):
        e=threading.Event()
        p.watch(lambda:(_ for _ in ()).throw(OSError()),e);self.assertTrue(e.is_set())
    def test_windows_worker_never_uses_crt_os_read(self):
        event=threading.Event();stream=type('Pipe',(),{'fileno':lambda self:12})()
        with patch.object(p.os,'name','nt'),patch.object(p,'windows_receiver',return_value=lambda:b'cancel\n')as factory,patch.object(p.os,'read',side_effect=AssertionError('no CRT read')):
            t=p.start(stream,event);t.join(1)
        factory.assert_called_once_with(12);self.assertTrue(event.is_set());self.assertTrue(t.daemon);self.assertFalse(t.is_alive())

    def test_configuration_read_leaves_following_cancel_in_raw_pipe(self):
        import os
        for tail in (b'cancel\n',b'cancel\r\n'):
            read,write=os.pipe()
            try:
                os.write(write,b'{}\n'+tail)
                with os.fdopen(read,'r',closefd=False)as stream:
                    self.assertEqual(p.read_line(stream,100),'{}\n')
                    self.assertEqual(os.read(read,64),tail)
            finally:os.close(read);os.close(write)
    def test_buffer_only_configuration_fixture_remains_supported(self):
        self.assertEqual(p.read_line(io.StringIO('{}\n'),100),'{}\n')
    def test_configuration_limit_is_bounded_without_consuming_following_bytes(self):
        import os
        read,write=os.pipe()
        try:
            os.write(write,b'x'*10)
            with os.fdopen(read,'r',closefd=False)as stream:self.assertEqual(len(p.read_line(stream,4)),5)
            self.assertEqual(os.read(read,64),b'x'*5)
        finally:os.close(read);os.close(write)

if __name__=='__main__':unittest.main()
