"""One explicitly authorized target/name update for this test only; no send API."""
import re,json,os

def install(host,report,stage,desired):
    r=host.remarks;w=host.w
    r.validate_remark_input({'remarkName':desired})
    def prepare(self,screen,phone,check_budget):
        if self.prepared:raise w.StopPreview('remark_prepare_repeated')
        if not w.profile_matches(screen,phone):raise w.StopPreview('profile_phone_mismatch')
        self.perform('open_remark',screen,phone,check_budget)
        screen=self.read_until(r.remark_page,check_budget)
        second=self.driver.snapshot();w.guard(second)
        if not r.remark_page(second) or r.values(second)!=r.values(screen):raise w.StopPreview('remark_fields_changed')
        screen=second;before=r.values(screen);name_id,_,_=r.remark_layout(screen)
        node=w.unique([n for n in r.editors(screen) if n.name==name_id])
        expected=tuple((name,desired if name==name_id else text,desc,enabled) for name,text,desc,enabled in before)
        if node.text!=desired:
            fresh=self.driver.snapshot();w.guard(fresh)
            if fresh!=screen:raise w.StopPreview('remark_page_changed_before_write')
            q=self.driver.poco(type=node.kind,name=node.name)
            if len(q)==0:raise w.StopPreview('remark_element_missing')
            item=w.unique(list(q))
            if (item.attr('visible') is not True or item.attr('enabled') is not True
                or (item.attr('text') or '')!=node.text or (item.attr('name') or '')!=node.name
                or (item.attr('contentDescription') or '')!=node.desc
                or tuple(item.get_position())!=node.position or tuple(item.get_size())!=node.size):
                raise w.StopPreview('remark_element_changed')
            self.driver._guard_host();check_budget()
            # Explicit request supersedes preserve-nonempty only for this target's name.
            with (stage/'remark-once.json').open('x',encoding='utf8') as f:
                json.dump({'state':'write_or_unknown','remarkName':desired},f);f.flush();os.fsync(f.fileno())
            item.set_text(desired)
            report['remarkWriteIssued']=True
            def matches(page):
                if not r.remark_page(page):return False
                values=r.values(page)
                if values==expected:return True
                if values!=before:raise w.StopPreview('remark_readback_mismatch')
                return False
            screen=self.read_until(matches,check_budget)
            self.perform('save_remark',screen,phone,check_budget,r.RemarkContext(expected))
            screen=self.profile(phone,check_budget)
            self.perform('open_remark',screen,phone,check_budget)
            screen=self.read_until(r.remark_page,check_budget)
            if r.values(screen)!=expected:raise w.StopPreview('remark_persistence_unconfirmed')
            second=self.driver.snapshot();w.guard(second)
            if not r.remark_page(second) or r.values(second)!=expected:raise w.StopPreview('remark_persistence_unstable')
            screen=second;self.saved=True;self.save_status='confirmed'
            report['remarkSaveClickCount']=1
        else:
            self.save_status='not_needed';report['remarkSaveClickCount']=0
        report['remarkNameVerified']=desired
        report['otherRemarkFieldsPreserved']=True
        self.perform('close_remark',screen,phone,check_budget,r.RemarkContext(expected))
        screen=self.profile(phone,check_budget);self.prepared=True
        return screen
    r._RemarkingDriver.prepare=prepare
