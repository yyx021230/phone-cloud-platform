# C2内容指纹编码提案 WCMUT1（verification-only，未实现）

这是新提案，不声称符合某个现成JSON canonical标准。只为冻结跨实现golden合同，不是生产兼容承诺；当前没有encoder/parser代码、通过测试或source authority。

输入为严格JSON树。plain object只接受Object.prototype或null prototype。禁止undefined/function/symbol/BigInt、cycle、其他prototype、accessor（不得调用）、symbol/nonenumerable额外字段、array holes/额外属性，以及未配对Unicode surrogate。原始JSON文本入口须先拒重复key，不能等普通JSON.parse把重复字段折叠后补查。根最大256KiB编码（含域前缀）、50000节点、深度24，根深度0、对象key和值/数组元素均加一深度且各计节点，超限拒绝；数组固有length不当额外字段。对象键按Unicode scalar code point序列排序，不用locale或JavaScript默认UTF16排序；不做NFC/NFKC或大小写转换，数组顺序保留。

编码是UTF8域前缀 `WCMUT1` 加一个00字节，再接下面唯一typed binary树；所有长度/count用4字节无符号big-endian。长度是UTF8字节数，不是字符或UTF16单元数。

|值|编码|
|---|---|
|null|00|
|false / true|01 / 02|
|string|03 + u32字节数 + 原UTF8字节；只转码不JSON转义|
|number|04 + 8字节big-endian IEEE754 binary64；拒NaN/Infinity/-Infinity/negative zero，整数还须在±9007199254740991内|
|array|05 + u32元素数 + 每元素编码|
|object|06 + u32成员数 + 按上述顺序逐对编码key字符串、value|

fingerprint为以上完整bytes的SHA256小写64hex，不能hash JSON显示字符串或只挑status。记录自身receiptFingerprint计算时仅排除该自身字段；其他字段包括version/purpose/operationId/full owner/authority/revision/expected和next完整proposal都参与。嵌套fingerprint用途要有purpose区分，禁止把一个task指纹直接当整个proposal指纹。

数值语义明确为binary64：小数0.1按对应binary64位编码，不能用十进制格式化字符串随实现变化；unsafe integer拒绝而不四舍五入。数据库JSONB数值可能超出此域，必须在读取边界证明原值可无损接受，必要时拒绝目标；不能从已经精度丢失的JS值声明来源已验证。实际原JSONB→规范输入的验证方法还待根定，不能把本算法当该证明。后续若改域或编码必须另version，不移动既有golden。

GOLDEN_VECTORS.json是固定值/明确编码bytes/摘要的**规范数据**，未运行encoder测试。含非BMP键排序、中文/emoji、数组顺序与对象插入顺序不敏感；拒绝向量另列。生成摘要只对给定hex bytes做SHA256，不证明任何canonicalizer实现正确。根审后才允许写verification encoder与对这些独立固定bytes的测试。
