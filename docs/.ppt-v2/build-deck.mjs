import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "/Users/yyx/ztqc/phone-cloud-platform/docs/.ppt-v2";
const OUT = `${ROOT}/output`;
const FINAL = "/Users/yyx/ztqc/phone-cloud-platform/docs/AI前端设计教学课件_重制版.pptx";
const HERO_1 = `${ROOT}/assets/hero-workflow.png`;
const HERO_2 = `${ROOT}/assets/hero-trust-ui.png`;

const C = {
  ink: "#080D19",
  ink2: "#111A2F",
  white: "#F7F9FF",
  muted: "#A9B6D0",
  blue: "#4D78FF",
  lime: "#D9FF45",
  pale: "#EEF2FA",
  gray: "#64718A",
  line: "#26334F",
};

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function box(slide, { x, y, w, h, fill = "none", line = "none", radius = 0 }) {
  return slide.shapes.add({
    geometry: radius ? "roundRect" : "rect",
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: line, width: line === "none" ? 0 : 1 },
    ...(radius ? { borderRadius: radius } : {}),
  });
}

function txt(slide, text, { x, y, w, h, size = 28, color = C.white, bold = false, align = "left", font = "PingFang SC" }) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = { fontSize: size, color, bold, typeface: font, alignment: align, verticalAlignment: "top" };
  return shape;
}

function rule(slide, x, y, w, fill = C.line, h = 2) {
  return box(slide, { x, y, w, h, fill, line: "none" });
}

function footer(slide, n, dark = true) {
  rule(slide, 52, 676, 1176, dark ? C.line : "#D5DCE8", 1);
  txt(slide, "AI 前端设计课", { x: 52, y: 686, w: 240, h: 20, size: 13, color: dark ? C.muted : C.gray });
  txt(slide, String(n).padStart(2, "0"), { x: 1178, y: 686, w: 50, h: 20, size: 13, color: dark ? C.muted : C.gray, align: "right" });
}

function notes(slide, sourceLines) {
  slide.speakerNotes.textFrame.setText(["[Sources]", ...sourceLines].join("\n"));
  slide.speakerNotes.setVisible(true);
}

function label(slide, text, x, y, dark = true) {
  txt(slide, text, { x, y, w: 300, h: 25, size: 16, color: dark ? C.lime : C.blue, bold: true });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const hero1 = await fs.readFile(HERO_1);
  const hero2 = await fs.readFile(HERO_2);
  const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const slides = [];
  const pair = "Google PAIR: https://pair.withgoogle.com/guidebook-v2/";
  const hax = "Microsoft HAX: https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/";
  const figma = "Figma Make: https://help.figma.com/hc/en-us/articles/31304485164695-Create-and-edit-a-functional-prototype-or-web-app";
  const v0 = "Vercel v0 prompting guide: https://vercel.com/blog/how-to-prompt-v0";
  const openai = "OpenAI API Quickstart: https://platform.openai.com/docs/quickstart/make-your-first-api-request";

  // 1 — opening
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    s.images.add({ blob: hero1, contentType: "image/png", alt: "从模糊需求到精确前端设计的工作流视觉", fit: "cover", position: { left: 0, top: 0, width: 1280, height: 720 } });
    box(s, { x: 0, y: 0, w: 585, h: 720, fill: C.ink, line: "none" });
    box(s, { x: 52, y: 68, w: 78, h: 8, fill: C.lime, line: "none" });
    label(s, "明天就能讲的一堂课", 52, 98);
    txt(s, "AI 开发中的\n前端设计", { x: 52, y: 166, w: 500, h: 200, size: 58, color: C.white, bold: true });
    txt(s, "不是让 AI 替你画页面。\n而是用前端设计，把 AI 变成可交付的产品。", { x: 52, y: 408, w: 450, h: 115, size: 25, color: C.muted });
    txt(s, "关键词 / 需求卡 · 交互状态 · 人类接管 · 结构化输出", { x: 52, y: 590, w: 500, h: 35, size: 17, color: C.white });
    footer(s, 1); slides.push(s); notes(s, [pair, figma, v0, "Visual generated with OpenAI image generation for this deck."]);
  }

  // 2 — core claim
  {
    const s = p.slides.add(); s.background.fill = C.white;
    label(s, "先给结论", 58, 58, false);
    txt(s, "AI 把“画页面”变快了，\n却把“想清楚”变得更重要。", { x: 58, y: 105, w: 1060, h: 150, size: 52, color: C.ink, bold: true });
    rule(s, 58, 296, 1164, "#D8E0F0", 2);
    txt(s, "过去", { x: 58, y: 346, w: 180, h: 35, size: 20, color: C.gray, bold: true });
    txt(s, "把页面画出来", { x: 58, y: 392, w: 310, h: 70, size: 38, color: C.ink, bold: true });
    txt(s, "↓", { x: 430, y: 390, w: 60, h: 60, size: 40, color: C.blue, bold: true, align: "center" });
    txt(s, "现在", { x: 550, y: 346, w: 180, h: 35, size: 20, color: C.blue, bold: true });
    txt(s, "把“用户、场景、约束、\n失败路径”设计进去", { x: 550, y: 388, w: 610, h: 100, size: 38, color: C.ink, bold: true });
    box(s, { x: 58, y: 548, w: 1138, h: 72, fill: "#E8EEFF", line: "none", radius: 18 });
    txt(s, "真正稀缺的能力：减少 AI 替你“瞎猜”的空间。", { x: 86, y: 568, w: 1040, h: 35, size: 26, color: C.ink, bold: true });
    footer(s, 2, false); slides.push(s); notes(s, [figma, v0]);
  }

  // 3 — contrast
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    label(s, "第一步：把一句需求改成设计规格", 58, 56);
    txt(s, "“帮我做个数据看板”\n为什么通常会做砸？", { x: 58, y: 104, w: 760, h: 120, size: 48, color: C.white, bold: true });
    box(s, { x: 58, y: 275, w: 470, h: 280, fill: "#172038", line: "none", radius: 22 });
    txt(s, "模糊输入", { x: 86, y: 306, w: 250, h: 32, size: 20, color: C.lime, bold: true });
    txt(s, "“做一个好看的\n销售数据看板。”", { x: 86, y: 365, w: 360, h: 95, size: 33, color: C.white, bold: true });
    txt(s, "它只能猜：谁在用？\n看什么？什么时候用？\n出错了怎么办？", { x: 86, y: 477, w: 350, h: 75, size: 21, color: C.muted });
    txt(s, "→", { x: 552, y: 375, w: 90, h: 55, size: 48, color: C.lime, bold: true, align: "center" });
    box(s, { x: 675, y: 250, w: 540, h: 340, fill: C.lime, line: "none", radius: 22 });
    txt(s, "可交付规格", { x: 708, y: 285, w: 270, h: 32, size: 20, color: C.ink, bold: true });
    txt(s, "门店经理\n在早晨站会前 3 分钟\n用手机定位异常。", { x: 708, y: 340, w: 470, h: 115, size: 31, color: C.ink, bold: true });
    txt(s, "必须：本周数据 / 主操作首屏 /\n加载、空、错误状态 / 可重试。", { x: 708, y: 488, w: 470, h: 65, size: 21, color: C.ink });
    footer(s, 3); slides.push(s); notes(s, [figma, v0]);
  }

  // 4 — requirement card
  {
    const s = p.slides.add(); s.background.fill = C.white;
    label(s, "拿走就能用的模板", 58, 58, false);
    txt(s, "一张设计规格卡，\n让 AI 的第一版就接近可用。", { x: 58, y: 106, w: 760, h: 130, size: 47, color: C.ink, bold: true });
    const xs = [58, 328, 598, 868];
    const nums = ["01", "02", "03", "04"];
    const heads = ["用户", "任务", "状态", "验收"];
    const bodies = ["谁在什么时刻、\n什么设备上使用？", "用户要做哪个\n关键决定？", "加载、空、错、\n无权限如何呈现？", "怎样算成功？\n如何被测试？"];
    for (let i = 0; i < 4; i++) {
      box(s, { x: xs[i], y: 332, w: 235, h: 220, fill: i === 3 ? "#E8EEFF" : C.pale, line: "none", radius: 18 });
      txt(s, nums[i], { x: xs[i] + 22, y: 357, w: 70, h: 28, size: 17, color: C.blue, bold: true });
      txt(s, heads[i], { x: xs[i] + 22, y: 404, w: 170, h: 42, size: 30, color: C.ink, bold: true });
      txt(s, bodies[i], { x: xs[i] + 22, y: 465, w: 190, h: 65, size: 20, color: C.gray });
    }
    txt(s, "讲课时让学生先填这 4 格，再碰任何生成工具。", { x: 58, y: 604, w: 1000, h: 35, size: 25, color: C.ink, bold: true });
    footer(s, 4, false); slides.push(s); notes(s, [figma, v0]);
  }

  // 5 — iteration
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    label(s, "方法不是“一次生成”", 58, 58);
    txt(s, "好页面，通常来自三轮对话。", { x: 58, y: 104, w: 900, h: 65, size: 47, color: C.white, bold: true });
    rule(s, 110, 380, 1050, C.line, 4);
    const steps = [
      ["01", "先定骨架", "信息层级 / 主任务\n不谈配色，不谈动画"],
      ["02", "再补行为", "筛选、编辑、确认、撤销\n补齐加载、空、错误"],
      ["03", "最后精修", "移动端 / 文案 / 无障碍\n代码与真实数据验证"],
    ];
    const x2 = [80, 455, 830];
    for (let i = 0; i < 3; i++) {
      box(s, { x: x2[i], y: 338, w: 26, h: 26, fill: i === 2 ? C.lime : C.blue, line: "none", radius: 13 });
      txt(s, steps[i][0], { x: x2[i], y: 230, w: 120, h: 25, size: 17, color: C.lime, bold: true });
      txt(s, steps[i][1], { x: x2[i], y: 420, w: 250, h: 42, size: 31, color: C.white, bold: true });
      txt(s, steps[i][2], { x: x2[i], y: 482, w: 300, h: 70, size: 21, color: C.muted });
    }
    txt(s, "一句话：先把“什么页面”说清楚，再让 AI 帮你把它做漂亮。", { x: 58, y: 605, w: 1120, h: 32, size: 25, color: C.white, bold: true });
    footer(s, 5); slides.push(s); notes(s, [figma, v0]);
  }

  // 6 — AI native visual
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    s.images.add({ blob: hero2, contentType: "image/png", alt: "可信 AI 交互界面视觉", fit: "cover", position: { left: 0, top: 0, width: 1280, height: 720 } });
    box(s, { x: 0, y: 0, w: 580, h: 720, fill: C.ink, line: "none" });
    label(s, "第二条线：为 AI 做前端", 52, 70);
    txt(s, "AI 产品\n不能只画\n一个聊天框。", { x: 52, y: 135, w: 460, h: 220, size: 55, color: C.white, bold: true });
    txt(s, "用户需要知道：\n它在做什么、凭什么这么说、\n我能不能改、失败后怎么办。", { x: 52, y: 415, w: 430, h: 105, size: 25, color: C.muted });
    box(s, { x: 52, y: 574, w: 324, h: 48, fill: C.lime, line: "none", radius: 12 });
    txt(s, "可信  ·  可控  ·  可恢复", { x: 70, y: 587, w: 295, h: 26, size: 19, color: C.ink, bold: true, align: "center" });
    footer(s, 6); slides.push(s); notes(s, [pair, hax, "Visual generated with OpenAI image generation for this deck."]);
  }

  // 7 — states
  {
    const s = p.slides.add(); s.background.fill = C.white;
    label(s, "AI 的体验不是一个静态页面", 58, 58, false);
    txt(s, "把状态设计出来，\n用户才不会被黑箱困住。", { x: 58, y: 106, w: 760, h: 120, size: 47, color: C.ink, bold: true });
    const cards = [
      ["输入前", "给真实示例\n说明数据范围"],
      ["生成中", "说清当前阶段\n允许停止"],
      ["结果后", "可编辑、可核验\n高风险须确认"],
      ["失败时", "保留输入\n重试 / 改写 / 转人工"],
    ];
    const x3 = [58, 344, 630, 916];
    for (let i = 0; i < 4; i++) {
      box(s, { x: x3[i], y: 328, w: 246, h: 212, fill: i === 3 ? "#1A2240" : C.pale, line: "none", radius: 18 });
      txt(s, `0${i + 1}`, { x: x3[i] + 22, y: 350, w: 50, h: 24, size: 16, color: i === 3 ? C.lime : C.blue, bold: true });
      txt(s, cards[i][0], { x: x3[i] + 22, y: 400, w: 180, h: 35, size: 28, color: i === 3 ? C.white : C.ink, bold: true });
      txt(s, cards[i][1], { x: x3[i] + 22, y: 459, w: 190, h: 55, size: 20, color: i === 3 ? C.muted : C.gray });
    }
    txt(s, "演示提问：如果 AI 等了 20 秒、答错、或要帮用户“执行操作”，你们的界面分别如何反应？", { x: 58, y: 598, w: 1120, h: 35, size: 23, color: C.ink, bold: true });
    footer(s, 7, false); slides.push(s); notes(s, [pair, hax]);
  }

  // 8 — guardrails
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    label(s, "前端实现：三道护栏", 58, 58);
    txt(s, "模型负责“建议”，\n你的系统负责“决定”。", { x: 58, y: 105, w: 820, h: 125, size: 49, color: C.white, bold: true });
    const cols = [
      ["结构", "固定 JSON Schema\n把输出渲染成卡片、表格、表单。\n不要切割随机文本。"],
      ["权限", "模型可以建议调用工具。\n鉴权、写入、审计\n必须由服务端裁决。"],
      ["安全", "密钥不进浏览器。\n模型文本、外链、上传和\n工具返回都视为不可信输入。"],
    ];
    const x4 = [58, 455, 852];
    for (let i = 0; i < 3; i++) {
      rule(s, x4[i], 332, 310, i === 2 ? C.lime : C.blue, 6);
      txt(s, `0${i + 1}`, { x: x4[i], y: 360, w: 60, h: 24, size: 16, color: C.lime, bold: true });
      txt(s, cols[i][0], { x: x4[i], y: 409, w: 280, h: 42, size: 34, color: C.white, bold: true });
      txt(s, cols[i][1], { x: x4[i], y: 476, w: 325, h: 90, size: 21, color: C.muted });
    }
    footer(s, 8); slides.push(s); notes(s, [openai]);
  }

  // 9 — workshop
  {
    const s = p.slides.add(); s.background.fill = C.white;
    label(s, "课堂实战：10 分钟", 58, 58, false);
    txt(s, "让学生做一件小事：\n销售异常分析助手。", { x: 58, y: 106, w: 800, h: 120, size: 47, color: C.ink, bold: true });
    box(s, { x: 58, y: 304, w: 458, h: 278, fill: C.ink, line: "none", radius: 22 });
    txt(s, "给定场景", { x: 88, y: 339, w: 180, h: 32, size: 20, color: C.lime, bold: true });
    txt(s, "门店经理\n站会前 3 分钟\n决定今天先跟进谁。", { x: 88, y: 397, w: 340, h: 100, size: 32, color: C.white, bold: true });
    txt(s, "AI 可能：没有结果 / 低置信度 / 数据延迟。", { x: 88, y: 525, w: 340, h: 35, size: 18, color: C.muted });
    const ys = [323, 403, 483];
    const deliver = ["需求卡：用户、任务、状态、验收", "低保真：正常 / 加载 / 失败 / 确认", "提示词：任务 + 场景 + 约束 + 验收"];
    for (let i = 0; i < 3; i++) {
      box(s, { x: 590, y: ys[i], w: 612, h: 58, fill: i === 2 ? "#E8EEFF" : C.pale, line: "none", radius: 14 });
      txt(s, `0${i + 1}`, { x: 616, y: ys[i] + 17, w: 42, h: 22, size: 16, color: C.blue, bold: true });
      txt(s, deliver[i], { x: 680, y: ys[i] + 15, w: 480, h: 28, size: 22, color: C.ink, bold: true });
    }
    footer(s, 9, false); slides.push(s); notes(s, [pair, hax]);
  }

  // 10 — close
  {
    const s = p.slides.add(); s.background.fill = C.ink;
    box(s, { x: 52, y: 74, w: 76, h: 8, fill: C.lime, line: "none" });
    label(s, "收束", 52, 104);
    txt(s, "AI 前端设计的\n最后三问", { x: 52, y: 160, w: 520, h: 130, size: 53, color: C.white, bold: true });
    const qs = ["用户知道下一步做什么吗？", "AI 的结论能被核验、纠正吗？", "AI 慢了、错了、越权时，用户有出路吗？"];
    const yy = [162, 330, 498];
    for (let i = 0; i < 3; i++) {
      txt(s, `0${i + 1}`, { x: 684, y: yy[i], w: 62, h: 28, size: 18, color: C.lime, bold: true });
      txt(s, qs[i], { x: 770, y: yy[i] - 8, w: 430, h: 75, size: 29, color: C.white, bold: true });
      if (i < 2) rule(s, 684, yy[i] + 93, 510, C.line, 2);
    }
    txt(s, "能回答这三问，AI 才是产品能力，而不只是一个会说话的接口。", { x: 52, y: 594, w: 1080, h: 35, size: 25, color: C.muted });
    footer(s, 10); slides.push(s); notes(s, [pair, hax, figma, v0, openai]);
  }

  for (const [i, s] of slides.entries()) {
    await writeBlob(`${OUT}/slide-${String(i + 1).padStart(2, "0")}.png`, await p.export({ slide: s, format: "png", scale: 1 }));
    await fs.writeFile(`${OUT}/slide-${String(i + 1).padStart(2, "0")}.layout.json`, await (await s.export({ format: "layout" })).text());
  }
  await writeBlob(`${OUT}/montage.webp`, await p.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(p);
  await pptx.save(FINAL);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
