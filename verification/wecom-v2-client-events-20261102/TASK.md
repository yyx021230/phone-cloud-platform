# M2 rc.3：本调用checkout client错误事件归属

基线cd82c14f6baef51521d43213d22e445c7303ed8b（原fa245单次PG失败逐字归档），分支codex/wecom-v2-client-events-20261102。root实际依赖源码追踪确认并授权此最小修正；不修改pool/index/getPool/v1，不全局吞error或注册uncaughtException。旧失败库保持停止并保留，未重跑PG。

## 根因与先红后绿

实际pg checkout移除idleListener；unexpected end同步client.emit(error)早于nextTick query.handleError。仅Promise try/catch不能阻止无人监听的checked-out client错误，fixture Pool.on(error)也覆盖不到这一路径。源/hash/7实际失败见wecom-v2-pg-observed-20261102，不改成通过。

把原unit fake client升级成实际EventEmitter，仅改变事件能力不模拟PG/SQL语义。先在旧产品新增3实际入口反例：事件早于COMMIT query rejection、查询间事件、归属listener存在/清理；原30绿/新3红，RED源/输出/hash保留。测试在已知emit调用点捕获其同步throw作断言，未注册全局异常handler或启动网络。初次修正33通过后补6边界，当前39通过，不累计历史次数。

## 最小实现

每次checkout后只给这个client安装一个有准确引用的error observer；首个client事件或query拒绝锁定firstFailure。observer不抛出/不记原错误日志，但所有后继query边界和返回边界强制检查它，因此不是空吞错。第一故障之后不再在失信连接执行UPDATE/COMMIT/ROLLBACK；原错误对象交release(Error)销毁，先退役后独立读，后续错误不替首因。

COMMIT标志只在通过边界并实际调用query(COMMIT)时设定，之前被事件挡住不误称已发送。COMMIT在途丢失仍走原独立对账/零写重放；事件发生而query侥幸fulfilled也不得直接成功。成功/协议异常/驱动失败/最终兜底均移除且仅移除本次listener，不碰外部已存在监听；查询失败的连接不归还为健康池client。缺事件接口在BEGIN前保守失败。

本模块不拥有checkout完成前或归还后的idle Pool生命周期，未来真实接线仍须审全局pool错误契约。真实fixture下一稿须按实际故障client/时序有界记录预期断链，其他client/其他错误照样失败；不能靠fixture空handler把原7红消掉。原index/getPool/共享pool和v1未改。

## 实际验证与未验

- 当前39项EventEmitter/生命周期fake单元过：首错误身份、事件早于Promise拒绝、查询间/BEGIN止步、COMMIT事件与fulfilled query、监听清理/外部监听保留、仅Promise失败、其他client仍抛错/无全局handler、接口缺失；无网络/PG。
- 原M1 61与v1/Agent50回归通过，两个改动JS syntax通过。14旧产品源、M1和DDL保持基线原字节。
- 原单次真实PG14测7/7依旧失败，原7失败/14 body notes/失败DB不改；本39不称真实PG修复已通过。M2 source已变，旧runner hash guard会拒绝，后继固定新runner稿交root审后才可再开新私有库，禁止重启旧失败库。
- 原观察commit的INITDB.txt:24空白EOF是原始initdb输出，完整历史diffcheck报告该格式项；不清洗原件。当前红TAP若有格式警告，准确原始路径/行号与只排除此证据的代码检查分开记录，不冒称完整检查绿。

只提交M2新叶/同名测试、本目录证据和主文档；不改M1/v1/DDL/Agent/Windows/手机/生产，不接执行/释放，所有结果held/protocolPermit false。原43/147/52、155/157查名池及冻结保持；真机主号分身验收未完成。
