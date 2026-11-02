# S1 rc.2：规范化bigint必须是字符串

基线ac9002f285f2d3dc68cf60b9249a0740eb9131ec；root b7b55483独立53项通过后，实际纯模块反例把anchor.mapping_revision改Number1仍返回retain_canonical，与SCHEMA的规范化PG bigint正整数字符串要求不一致。所有原输出权限均false，不是实际释放/执行漏洞；原模块未接共享writer。

red保存root原counter/红源/输出/回执/审查逐字副本，及owner旧模块、追加typed测试后的红源/fixture/实际输出/hash。owner原64项62过2失败，只有Number1和混合两目标反例红；原53不修改、不弱化。原rc.1/tag/53绿保留。

产品只一处：先typeof mapping_revision==='string'，再正整数字面量校验，去掉String()升格。新增Number1/Boolean true false/前导零/零/负/小数/null拒绝、合法'1'/'2'保留、第一设备非法第二正常继续，当前64项全部通过。输入/decision/输出零权限、原旧v1/NULL不升级、全tuple/业务指纹语义不变。

未改M1/M2/M3/DDL/index/getPool/shared repository/Agent；没有SQL/PG/Windows/手机/生产动作。预先准备但未提交的M2兼容verification目录保留不混入本提交；原43设备清理义务/147/52/查名池/冻结保持，主号/分身仍未真机验收。原始失败输出空白按原字节保留，例外必须具名列明，不能洗成完整diffcheck通过。
