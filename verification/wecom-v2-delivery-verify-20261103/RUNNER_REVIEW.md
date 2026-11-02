# C1源码候选：两组SQL尚未执行

根3715a0d限定后新增此verification目录，基线b4641e4。产品、helper、比较SQL、M1/M2/M3、DDL、shared与Agent均未改。

本地直接导入当前managed/gallery helper26项通过，保留running+matching token+ackedAt即使到期仍幂等的语义；覆盖三种profile及WeCom主号/分身当前不支持lease。6个runner guards、2个实际seed唯一/碰撞反例通过；后者调用真实claim preparer确认嵌套未知JSON进入候选。AST/JS syntax与16源/6既有依赖hash核对通过，不等于SQL解析或PG执行，不测试HTTP鉴权或真机。

待根审后固定源一次运行：delivery-fields核完整RETURNING、恰三JSON路径与SQL updated_at更新，剔除三字段后所有已知未知字段完整深等；delivery-stale-proposal先较新后较旧各真实提交，检查旧候选实际替换，不冒称并发/EPQ。两组均用原M3真实claim、所有job/business/hold/ledger/anchor/device完整保持；明确COMMIT、client释放后独立新Pool/backend读取，再M3 fresh recorded。直接在合成WeCom行执行SQL不证明现行WeCom leased分支可达；未测repository整个audit方法。

owned runner由原B已审版本最小复制，仅新prefix pc-wecom-v2-delivery-pg-/marker和expected两组调整。仍非root/无Linux capability、source guard在目录/进程/socket前、minimal env、不读取配置数据库；PG16.15/Node25.9/pg8.22既有依赖；新0700目录、随机loopback端口>=20000、私有socket、fsync/sync commit/full page on。Node45秒、SQL2/3/5秒，连接2秒/query6秒。仅原未reap Popen child进程组清理，PG原child SIGINT确认；失败保留原件/db，成功只有证据两case齐且源后匹配/Node组消失/PG退出确认后删owned成功db。不碰旧库/共享PG/Windows/ADB/媒体。

没有实现C2稳定receipt/authorizer/DDL/lookup/shared接线，不把M3 recorded当本次独立mutation未知提交已恢复。43/147/52和查名池义务保持，主号分身真机未完成；不推送/上线。
