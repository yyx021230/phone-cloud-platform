import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "/Users/yyx/ztqc/phone-cloud-platform/docs/.ppt-v3";
const OUT = `${ROOT}/output`;
const FINAL = "/Users/yyx/ztqc/phone-cloud-platform/docs/AI前端设计工作坊课件.pptx";
const HERO_1 = "/Users/yyx/ztqc/phone-cloud-platform/docs/.ppt-v2/assets/hero-workflow.png";
const HERO_2 = "/Users/yyx/ztqc/phone-cloud-platform/docs/.ppt-v2/assets/hero-trust-ui.png";

const C = { ink: "#080D19", white: "#F7F9FF", muted: "#AAB8D4", blue: "#4E79FF", lime: "#D9FF45", pale: "#EEF2FA", navy: "#192343", gray: "#66738D", rule: "#2A3857" };

async function writeBlob(path, blob) { await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer())); }
function rect(slide, x, y, w, h, fill, radius = 0, line = "none") {
  return slide.shapes.add({ geometry: radius ? "roundRect" : "rect", position: { left: x, top: y, width: w, height: h }, fill, line: { style: "solid", fill: line, width: line === "none" ? 0 : 1 }, ...(radius ? { borderRadius: radius } : {}) });
}
function text(slide, content, x, y, w, h, size, color, bold = false, align = "left") {
  const t = slide.shapes.add({ geometry: "textbox", position: { left: x, top: y, width: w, height: h }, fill: "none", line: { style: "solid", fill: "none", width: 0 } });
  t.text = content; t.text.style = { fontSize: size, color, bold, typeface: "PingFang SC", alignment: align, verticalAlignment: "top" }; return t;
}
function line(slide, x, y, w, color, h = 2) { return rect(slide, x, y, w, h, color); }
function tag(slide, content, x, y, dark = true) { text(slide, content, x, y, 420, 24, 16, dark ? C.lime : C.blue, true); }
function footer(slide, index, dark = true) { line(slide, 52, 676, 1176, dark ? C.rule : "#D5DDEC", 1); text(slide, "AI 前端设计工作坊", 52, 686, 250, 18, 13, dark ? C.muted : C.gray); text(slide, String(index).padStart(2, "0"), 1174, 686, 54, 18, 13, dark ? C.muted : C.gray, false, "right"); }
function note(slide, body) { slide.speakerNotes.textFrame.setText("[Sources]\n" + body); slide.speakerNotes.setVisible(true); }

function questionCard(slide, index, title, prompt, x, y, dark = false, h = 210) {
  rect(slide, x, y, 352, h, dark ? C.navy : C.pale, 18);
  text(slide, `0${index}`, x + 24, y + 24, 45, 22, 16, dark ? C.lime : C.blue, true);
  text(slide, title, x + 24, y + 66, 290, 36, 27, dark ? C.white : C.ink, true);
  text(slide, prompt, x + 24, y + 116, 292, h - 130, 19, dark ? C.muted : C.gray);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const hero1 = await fs.readFile(HERO_1); const hero2 = await fs.readFile(HERO_2);
  const p = Presentation.create({ slideSize: { width: 1280, height: 720 } }); const slides = [];
  const pair = "Google PAIR Workshop Slides: https://pair.withgoogle.com/guidebook-v2/workshop/Guidebook-Workshop-Slides.pdf";
  const codelab = "Google Codelab: https://codelabs.developers.google.com/codelabs/pair-guidebook";
  const chi = "CHI 2025 GenAI Design Thinking course: https://sites.google.com/umd.edu/genaidesignthinking";
  const hax = "Microsoft HAX: https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/";

  // 1. Cover
  { const s = p.slides.add(); s.background.fill = C.ink;
    s.images.add({ blob: hero1, contentType: "image/png", alt: "AI 前端设计工作流", fit: "cover", position: { left: 0, top: 0, width: 1280, height: 720 } }); rect(s, 0, 0, 595, 720, C.ink); rect(s, 52, 68, 88, 8, C.lime); tag(s, "从案例出发的课堂工作坊", 52, 100); text(s, "AI 前端设计\n工作坊", 52, 166, 500, 152, 58, C.white, true); text(s, "把一个“能回答”的 AI 功能，\n设计成用户敢用、能改、能验证的产品。", 52, 406, 470, 88, 25, C.muted); text(s, "今天的产出：关键时刻图 · 审计表 · 低保真方案", 52, 595, 500, 28, 18, C.white); footer(s, 1); slides.push(s); note(s, `${pair}\n${chi}\nVisual generated with OpenAI image generation for this deck.`); }

  // 2. Outcomes
  { const s = p.slides.add(); s.background.fill = C.white; tag(s, "这不是听完就忘的分享", 58, 58, false); text(s, "这堂课结束时，\n每组要带走 4 个东西。", 58, 108, 760, 120, 49, C.ink, true);
    const items = [["01", "关键时刻", "AI 最可能帮上忙或帮倒忙的那一刻"], ["02", "机会陈述", "用用户的语气说清“我需要什么”"], ["03", "控制审计", "哪里要确认、拒绝、修改与撤销"], ["04", "一张草图", "把状态和证据放进页面"]];
    const xs = [58, 344, 630, 916]; for (let i = 0; i < 4; i++) { rect(s, xs[i], 338, 246, 206, i === 3 ? "#E7EDFF" : C.pale, 18); text(s, items[i][0], xs[i] + 24, 364, 45, 22, 16, C.blue, true); text(s, items[i][1], xs[i] + 24, 411, 180, 36, 28, C.ink, true); text(s, items[i][2], xs[i] + 24, 470, 188, 48, 18, C.gray); }
    text(s, "规则：所有概念都要回到同一个案例；每讲 1 个方法，就产出 1 张可用的设计工件。", 58, 600, 1120, 32, 23, C.ink, true); footer(s, 2, false); slides.push(s); note(s, `${pair}\n${chi}`); }

  // 3. Case
  { const s = p.slides.add(); s.background.fill = C.ink; tag(s, "贯穿案例：销售异常分析助手", 58, 56); text(s, "先别设计页面。\n先认识你要解决的用户时刻。", 58, 105, 800, 115, 47, C.white, true);
    rect(s, 58, 302, 480, 258, C.navy, 20); text(s, "场景", 86, 332, 120, 26, 19, C.lime, true); text(s, "门店经理在早晨站会前 3 分钟，\n要决定今天先跟进哪一家门店。", 86, 386, 390, 75, 29, C.white, true); text(s, "数据：昨日销售、库存预警、AI 原因摘要。", 86, 522, 360, 24, 17, C.muted);
    rect(s, 660, 302, 555, 258, C.lime, 20); text(s, "AI 会做什么？", 692, 332, 260, 26, 19, C.ink, true); text(s, "分析异常\n生成原因摘要\n生成跟进消息草稿", 692, 382, 350, 102, 31, C.ink, true); text(s, "它也可能：无结果、低置信度、数据延迟、建议不当。", 692, 512, 440, 28, 18, C.ink); footer(s, 3); slides.push(s); note(s, `${pair}\n${codelab}`); }

  // 4. Warm-up
  { const s = p.slides.add(); s.background.fill = C.white; tag(s, "热身：先找风险，而不是先找功能", 58, 58, false); text(s, "如果它做错了，\n哪一个时刻最可能让用户受伤？", 58, 107, 900, 118, 49, C.ink, true);
    questionCard(s, 1, "看不到异常", "AI 漏掉一家真的有问题的门店。", 58, 330); questionCard(s, 2, "解释不可信", "它说“库存导致下滑”，但没有证据。", 464, 330); questionCard(s, 3, "越权执行", "它把跟进消息直接发给客户。", 870, 330, true);
    text(s, "讨论：请选择一个时刻。它的后果是什么？用户当时最需要什么？", 58, 600, 1100, 30, 23, C.ink, true); footer(s, 4, false); slides.push(s); note(s, `${pair}\n活动提示：小组 5 分钟，选一个关键时刻；记录“后果”和“用户需要”。`); }

  // 5. Critical moment map
  { const s = p.slides.add(); s.background.fill = C.ink; tag(s, "工件 1：关键时刻图", 58, 56); text(s, "把 AI 功能拆成 5 个时刻，\n圈出最需要设计的那一个。", 58, 105, 850, 118, 47, C.white, true);
    const steps = [["打开看板", "看到门店列表"], ["选择异常", "查看 AI 原因"], ["核验证据", "判断是否可信"], ["生成草稿", "编辑跟进消息"], ["确认发送", "留下审计记录"]]; const xs = [58, 290, 522, 754, 986];
    line(s, 95, 395, 1070, C.rule, 4); for (let i = 0; i < 5; i++) { rect(s, xs[i], 381, 28, 28, i === 2 ? C.lime : C.blue, 14); text(s, `0${i + 1}`, xs[i], 308, 80, 20, 16, C.lime, true); text(s, steps[i][0], xs[i], 447, 195, 32, 25, C.white, true); text(s, steps[i][1], xs[i], 495, 195, 28, 18, C.muted); }
    rect(s, 58, 592, 1138, 54, "#16203A", 12); text(s, "你们要圈：哪个时刻的“错误后果”最高？这个时刻就是接下来所有设计的焦点。", 82, 606, 1060, 28, 22, C.white, true); footer(s, 5); slides.push(s); note(s, `${pair}\n活动提示：小组 7 分钟，圈一个关键时刻并写下原因。`); }

  // 6. opportunity statement
  { const s = p.slides.add(); s.background.fill = C.white; tag(s, "工件 2：机会陈述", 58, 58, false); text(s, "不说“我要加一个 AI 功能”。\n要用用户的语气，写出真正的问题。", 58, 107, 950, 118, 46, C.ink, true);
    rect(s, 58, 326, 1138, 148, C.ink, 20); text(s, "当  [ 关键时刻 ]  发生时，\n我需要  [ 用户需要 / 任务 ]  ，以便  [ 想避免的后果 / 目标 ] 。", 96, 362, 1020, 78, 31, C.white, true);
    questionCard(s, 1, "差的写法", "“给看板增加 AI 异常分析。”", 58, 500, false, 160); questionCard(s, 2, "好的写法", "“我需要知道原因是否可信，以便决定是否联系门店。”", 464, 500, true, 160); footer(s, 6, false); slides.push(s); note(s, `${pair}\n活动提示：小组 5 分钟；每组写一句机会陈述。`); }

  // 7. controls audit
  { const s = p.slides.add(); s.background.fill = C.ink; tag(s, "工件 3：控制与风险审计", 58, 56); text(s, "AI 能给建议，\n但不能偷走用户的决定权。", 58, 105, 820, 115, 48, C.white, true);
    const q = [["用户知道它依据什么吗？", "来源、时间、数据范围是否可查看？"], ["用户能拒绝或修改吗？", "结果能编辑吗？能否重新生成？"], ["如果错了，后果多大？", "低 / 中 / 高风险分别要什么确认？"]]; const xs = [58, 456, 854];
    for (let i = 0; i < 3; i++) { line(s, xs[i], 318, 318, i === 2 ? C.lime : C.blue, 6); text(s, `Q${i + 1}`, xs[i], 356, 50, 22, 16, C.lime, true); text(s, q[i][0], xs[i], 405, 320, 62, 29, C.white, true); text(s, q[i][1], xs[i], 495, 320, 50, 19, C.muted); }
    rect(s, 58, 590, 1138, 56, C.navy, 14); text(s, "审计结论：涉及“发送、删除、写入、付款”等动作时，默认让用户确认，并提供撤销或替代路径。", 84, 604, 1080, 27, 21, C.white, true); footer(s, 7); slides.push(s); note(s, `${pair}\n${hax}\n活动提示：小组 8 分钟，针对所选关键时刻回答 Q1–Q3。`); }

  // 8. state canvas
  { const s = p.slides.add(); s.background.fill = C.white; tag(s, "工件 4：把状态画进界面", 58, 58, false); text(s, "“正常结果”只是 1/4。\n其余 3 个状态决定用户是否信任它。", 58, 107, 900, 118, 47, C.ink, true);
    const cards = [["输入前", "示例任务\n数据范围 / 限制"], ["生成中", "当前阶段\n停止 / 取消"], ["结果后", "编辑 / 来源\n重新生成 / 确认"], ["失败时", "保留输入\n重试 / 改写 / 转人工"]]; const xs = [58, 344, 630, 916];
    for (let i = 0; i < 4; i++) { rect(s, xs[i], 330, 246, 210, i === 3 ? C.navy : C.pale, 18); text(s, `0${i + 1}`, xs[i] + 24, 354, 45, 22, 16, i === 3 ? C.lime : C.blue, true); text(s, cards[i][0], xs[i] + 24, 400, 185, 36, 28, i === 3 ? C.white : C.ink, true); text(s, cards[i][1], xs[i] + 24, 460, 185, 52, 19, i === 3 ? C.muted : C.gray); }
    text(s, "检查：页面里有没有“来源 / 编辑 / 停止 / 确认 / 重试”这五类入口？", 58, 600, 1080, 32, 23, C.ink, true); footer(s, 8, false); slides.push(s); note(s, `${pair}\n${hax}\n活动提示：小组 8 分钟，画出四种状态。`); }

  // 9. Visual evidence
  { const s = p.slides.add(); s.background.fill = C.ink; s.images.add({ blob: hero2, contentType: "image/png", alt: "可信 AI 前端界面视觉", fit: "cover", position: { left: 0, top: 0, width: 1280, height: 720 } }); rect(s, 0, 0, 520, 720, C.ink); tag(s, "参考：把可信交互做成可见界面", 52, 70); text(s, "用户不需要\nAI 像人。\n用户需要它\n清晰、可控、\n有证据。", 52, 132, 430, 260, 45, C.white, true); text(s, "把“魔法感”换成：\n阶段、来源、确认、撤销和反馈。", 52, 450, 410, 65, 23, C.muted); rect(s, 52, 573, 320, 48, C.lime, 12); text(s, "看得懂  ·  改得动  ·  有退路", 76, 587, 280, 22, 18, C.ink, true, "center"); footer(s, 9); slides.push(s); note(s, `${pair}\n${hax}\nVisual generated with OpenAI image generation for this deck.`); }

  // 10. technical guardrails
  { const s = p.slides.add(); s.background.fill = C.ink; tag(s, "工程落地：三道护栏", 58, 56); text(s, "模型负责“建议”，\n系统负责“决定”。", 58, 105, 820, 115, 49, C.white, true);
    const cols = [["结构", "固定 Schema\n用字段渲染卡片与表单\n不切割随机文本"], ["权限", "模型可以提议工具调用\n鉴权、写入、审计\n由服务端裁决"], ["安全", "密钥不进浏览器\n模型文本、外链、上传、\n工具返回均要校验"]]; const xs = [58, 455, 852];
    for (let i = 0; i < 3; i++) { line(s, xs[i], 330, 316, i === 2 ? C.lime : C.blue, 6); text(s, `0${i + 1}`, xs[i], 365, 50, 21, 16, C.lime, true); text(s, cols[i][0], xs[i], 412, 200, 36, 32, C.white, true); text(s, cols[i][1], xs[i], 475, 325, 80, 20, C.muted); }
    footer(s, 10); slides.push(s); note(s, "OpenAI API Quickstart: https://platform.openai.com/docs/quickstart/make-your-first-api-request"); }

  // 11. sprint instructions
  { const s = p.slides.add(); s.background.fill = C.white; tag(s, "设计冲刺：把四张工件收拢成一页", 58, 58, false); text(s, "最后一轮：每组做 1 页，\n并用 2 分钟讲清楚。", 58, 107, 840, 115, 47, C.ink, true);
    const items = [["A", "关键时刻", "画出用户流程，圈高风险时刻。"], ["B", "机会陈述", "用“我需要……以便……”写一句。"], ["C", "控制审计", "写清楚证据、确认、拒绝与撤销。"], ["D", "低保真草图", "画出正常、生成中、失败、确认。"]]; const xs = [58, 344, 630, 916];
    for (let i = 0; i < 4; i++) { rect(s, xs[i], 335, 246, 208, i === 3 ? "#E7EDFF" : C.pale, 18); text(s, items[i][0], xs[i] + 24, 359, 40, 24, 20, C.blue, true); text(s, items[i][1], xs[i] + 24, 410, 190, 36, 27, C.ink, true); text(s, items[i][2], xs[i] + 24, 468, 190, 50, 18, C.gray); }
    rect(s, 58, 590, 1138, 56, C.ink, 14); text(s, "汇报规则：不用介绍“功能很多”；只回答——用户在哪一刻最需要帮助、为什么这个设计值得信任。", 84, 605, 1070, 28, 21, C.white, true); footer(s, 11, false); slides.push(s); note(s, `${pair}\n活动提示：小组 12 分钟制作 + 每组 2 分钟汇报。`); }

  // 12. close
  { const s = p.slides.add(); s.background.fill = C.ink; rect(s, 52, 74, 80, 8, C.lime); tag(s, "复盘", 52, 104); text(s, "上完这堂课，\n以后都用这三问\n检查 AI 前端。", 52, 165, 540, 175, 51, C.white, true);
    const qs = [["01", "用户知道\n下一步做什么吗？"], ["02", "AI 的结论能被\n核验和纠正吗？"], ["03", "慢了、错了、越权时，\n用户有出路吗？"]]; const ys = [165, 332, 499];
    for (let i = 0; i < 3; i++) { text(s, qs[i][0], 700, ys[i], 55, 22, 18, C.lime, true); text(s, qs[i][1], 805, ys[i] - 9, 385, 70, 29, C.white, true); if (i < 2) line(s, 700, ys[i] + 95, 490, C.rule, 2); }
    text(s, "它们不保证 AI 永远正确，但能保证用户始终有理解、控制和恢复的路径。", 52, 590, 1110, 32, 24, C.muted); footer(s, 12); slides.push(s); note(s, `${pair}\n${hax}\n${chi}`); }

  for (const [i, slide] of slides.entries()) { await writeBlob(`${OUT}/slide-${String(i + 1).padStart(2, "0")}.png`, await p.export({ slide, format: "png", scale: 1 })); await fs.writeFile(`${OUT}/slide-${String(i + 1).padStart(2, "0")}.layout.json`, await (await slide.export({ format: "layout" })).text()); }
  await writeBlob(`${OUT}/montage.webp`, await p.export({ format: "webp", montage: true, scale: 1 })); const pptx = await PresentationFile.exportPptx(p); await pptx.save(FINAL);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
