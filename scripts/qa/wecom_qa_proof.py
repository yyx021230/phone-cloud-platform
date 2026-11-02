"""Prefer newly observed facts; waiting never refreshes an old timestamp."""
import time


def fresh_snapshot(read, generation, *, clock=time.monotonic, wait=time.sleep):
    snapshot=read();until=clock()+.6
    while snapshot.get('allowed')is True and clock()-snapshot.get('at',0)>.75 and clock()<until:
        wait(.02);snapshot=read()
    age=clock()-snapshot.get('at',0)
    allowed=(snapshot.get('allowed')is True and snapshot.get('generation')==generation and 0<=age<=.75)
    return snapshot,age,allowed


def current_snapshot(read, generation, fetch, *, clock=time.monotonic):
    row=read();age=clock()-row.get('at',0)
    if row.get('generation')==generation and row.get('allowed')is False:
        return row,age,False,'known_denial'
    if row.get('generation')==generation and row.get('allowed')is True and 0<=age<=.5:
        return row,age,True,'recent_cache'
    row=fetch()  # Its at must be the real read START, never the completion time.
    age=clock()-row.get('at',0)
    ok=row.get('generation')==generation and row.get('allowed')is True and 0<=age<=3
    return row,age,ok,'synchronous_fact'
