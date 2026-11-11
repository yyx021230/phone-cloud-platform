"""Prefer newly observed facts; waiting never refreshes an old timestamp."""
import time
import math


def fresh_snapshot(read, generation, *, clock=time.monotonic, wait=time.sleep):
    snapshot=read();until=clock()+.6
    while snapshot.get('allowed')is True and clock()-snapshot.get('at',0)>.75 and clock()<until:
        wait(.02);snapshot=read()
    age=clock()-snapshot.get('at',0)
    allowed=(snapshot.get('allowed')is True and snapshot.get('generation')==generation and 0<=age<=.75)
    return snapshot,age,allowed


def current_snapshot(read, generation, fetch, *, clock=time.monotonic, cache_max_age=.5):
    if type(cache_max_age)not in(int,float)or not math.isfinite(cache_max_age)or not 0<=cache_max_age<=2:
        raise ValueError('qa_cache_age_invalid')
    row=read();age=clock()-row.get('at',0)
    if row.get('generation')==generation and row.get('allowed')is False:
        return row,age,False,'known_denial'
    if row.get('generation')==generation and row.get('allowed')is True and 0<=age<=cache_max_age:
        return row,age,True,'recent_cache'
    row=fetch()  # Its at must be the real read START, never the completion time.
    age=clock()-row.get('at',0)
    ok=row.get('generation')==generation and row.get('allowed')is True and 0<=age<=3
    return row,age,ok,'synchronous_fact'
