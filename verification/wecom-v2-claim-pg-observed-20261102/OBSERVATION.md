# 首次M3a真实私有PG：18项17通过、1失败

根统一执行固定a7b07e0177e5d62e29030e1a6acaa29ec012606d / wecom-v2-claim-pg-20261102-draft.2，单次新根/private/tmp/pc-wecom-v2-claim-pg-gr_br461。此处7件原文件逐字复制，hash对照实际RUN_RECEIPT，执行源manifest从固定候选复制并核对18源Git字节；没有重跑/连接/修改测试库。失败db仍保留。

TAP真实18项17pass/1fail，PG_EVIDENCE只有17条已完成body note；runner没走全部通过分支，actualPgCases默认0不代表没执行。失败第16组read-only-reconcile在第一种missing-anchor seed重用了较早mapping-missing组的相同deviceId/serial，phone_cloud_devices_pkey 23505；缺行矩阵后段没有完成，不称全量通过。不是产品DDL/锁逻辑失败证据，也不能用其余17项掩盖未验项。

已通过的旧job→task交错实际服务端证据：old backend40984被leaf40990阻塞，control40991观察active/Lock/blockers[40990]，reads1/1.4195ms；新叶NOWAIT退出后旧第二锁取得。三条真实断链各原五DML只有一轮，COMMIT后真实C/Z/无E与新backend对账见原PG_EVIDENCE。其余具体结果以原TAP/body为准，不与旧M2 PG14累计。

Node40971exit1/组消失，PG40959exit0停止confirmed。原始INITDB第24行EOF空白保留，完整diffcheck预期warning，仅该raw作为具名例外。下一修正仅改本组missing-*为专属reconcile-missing-*并加纯fixture命名冲突检测；不加ON CONFLICT、不清前组行、不弱化断言，不重启该失败库；新源码再审后只在全新库重验。产品、DDL、Windows/手机/线上未动，原43/147/52和查名池保持，主号分身真机仍未验收。
