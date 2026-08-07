import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

import { buildSlide02 } from "./template/slide-02.mjs";
import { buildSlide06 } from "./template/slide-06.mjs";
import { buildSlide07 } from "./template/slide-07.mjs";
import { buildSlide10 } from "./template/slide-10.mjs";
import { buildSlide11 } from "./template/slide-11.mjs";
import { buildSlide17 } from "./template/slide-17.mjs";
import { buildSlide18 } from "./template/slide-18.mjs";
import { buildSlide19 } from "./template/slide-19.mjs";

const outputDir = "/Users/yyx/ztqc/phone-cloud-platform/docs/.ppt-build/output";
const finalPptx = "/Users/yyx/ztqc/phone-cloud-platform/docs/AI前端设计教学课件.pptx";

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function addNotes(slide, lines) {
  slide.speakerNotes.textFrame.setText(["[Sources]", ...lines].join("\n"));
  slide.speakerNotes.setVisible(true);
}

function threeBody(titleHere, loremIpsumDolorSitAmetConsecteturAdipiscing) {
  return { titleHere, topic: titleHere, loremIpsumDolorSitAmetConsecteturAdipiscing, loremIpsumDolorSitAmetConsecteturAdipiscing2: "" };
}

function doubleBody(loremIpsumDolorSitAmetConsecteturAdipiscing, loremIpsumDolorSitAmetConsecteturAdipiscing2 = "") {
  return { loremIpsumDolorSitAmetConsecteturAdipiscing, loremIpsumDolorSitAmetConsecteturAdipiscing2 };
}

function details(detailGoesHere, detailGoesHere2 = "", detailGoesHere3 = "") {
  return { detailGoesHere, detailGoesHere2, detailGoesHere3 };
}


function richify(value) {
  if (typeof value === "string") return { runs: [{ run: value }] };
  if (Array.isArray(value)) return value.map(richify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, richify(entry)]));
  }
  return value;
}

function make(builder, presentation, tokens) {
  console.log(`build-${builder.name}`);
  return builder(presentation, richify(tokens));
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const slides = [];

  slides.push(make(buildSlide02, presentation, {
    title: "AI 开发中的前端设计",
    title2: "课堂课件 · 2026",
    title3: "把“能生成”\n变成“能交付”",
  }));

  slides.push(make(buildSlide19, presentation, {
    footer1: "02",
    title: "今天带走的不是工具清单，而是一套可复用的方法",
    body1: threeBody("这节课的目标", "把界面需求写清楚，把 AI 的不确定性设计进去。"),
    stat1: "需求卡",
    body2: "减少 AI 的错误补全",
    stat2: "状态机",
    body3: "让用户看得懂、改得动",
    stat3: "评审表",
    body4: "把“看起来能用”变成“可以交付”",
  }));

  slides.push(make(buildSlide10, presentation, {
    footer1: "03",
    title: "先分清两件事：用 AI 做前端，和为 AI 做前端",
    body1: "AI 辅助前端开发\n目标：更快探索、生成、修改页面与代码。",
    body2: doubleBody("AI 原生产品前端\n目标：让用户理解、核验、控制 AI 的输出与动作。"),
    label1: "Figma Make",
    label2: "v0 / AI Studio",
    label3: "代码 Agent",
    label4: "智能问答",
    label5: "Agent 工作台",
  }));

  slides.push(make(buildSlide11, presentation, {
    footer1: "04",
    title: "同样是“做个看板”，输入质量决定结果质量",
    body1: threeBody("模糊需求", "只给一句话，工具只能猜测用户、数据、状态和设备。"),
    body2: "“帮我做一个数据看板。”",
    body3: "可交付规格",
    body4: details("门店经理在早晨站会上用手机定位异常；", "本周数据；红黄绿；最多三列；", "有加载、空数据、错误状态。"),
    body5: details("设计者的价值：", "减少工具的错误", "假设空间。"),
  }));

  slides.push(make(buildSlide07, presentation, {
    footer1: "05",
    title: "先写“设计规格卡”，再让 AI 生成页面",
    body1: "任务与用户\n谁在什么时刻，用什么设备，要完成什么决定？",
    body2: "信息与行为\n展示什么数据？点击、编辑、确认后发生什么？",
    body3: "状态与验收\n加载、空、错、无权限怎么呈现？什么算成功？",
  }));

  slides.push(make(buildSlide17, presentation, {
    footer1: "06",
    title: "用三轮迭代，代替“一次生成一个完美页面”",
    label1: "第 1 轮",
    label2: "第 2 轮",
    label3: "第 3 轮",
    body1: threeBody("页面骨架", "信息架构、层级、主任务。\n先别讨论炫酷效果。"),
    body2: threeBody("关键行为", "筛选、编辑、提交、撤销。\n补齐加载、空、错误状态。"),
    body3: threeBody("交付质量", "视觉、文案、手机端、可访问性、代码走查。"),
  }));

  slides.push(make(buildSlide10, presentation, {
    footer1: "07",
    title: "把提示词写成“任务 + 场景 + 约束 + 验收”",
    body1: "任务：页面与核心动作。\n场景：用户、时刻、设备。",
    body2: doubleBody("示例\n“主操作首屏可见；375px 宽不横向滚动；", "接口失败时保留已填内容并可重试。”"),
    label1: "任务",
    label2: "用户场景",
    label3: "内容与行为",
    label4: "设计约束",
    label5: "验收标准",
  }));

  slides.push(make(buildSlide19, presentation, {
    footer1: "08",
    title: "AI 产品的前端，关键在“可信、可控、可恢复”",
    body1: threeBody("五条原则", "能力边界可见；不确定性可见；人能接管；过程可理解；失败有出路。"),
    stat1: "说清楚",
    body2: "能做什么、使用哪些数据、有哪些限制",
    stat2: "留给人",
    body3: "编辑、拒绝、确认、撤销与人工替代",
    stat3: "给出路",
    body4: "停止、重试、改写请求、查看证据",
  }));

  slides.push(make(buildSlide18, presentation, {
    footer1: "09",
    title: "别只画聊天框：至少覆盖这三段体验",
    body1: threeBody("1. 输入前", "给真实示例、说明范围与数据来源，帮助用户形成正确预期。"),
    body2: threeBody("2. 生成中", "显示可理解的阶段；允许停止；不要伪装“思考过程”。"),
    body3: threeBody("3. 结果后", "结论可编辑、可核验；高风险操作确认；出错可恢复。"),
    label1: "引导",
    label2: "过程",
    label3: "结果",
  }));

  slides.push(make(buildSlide06, presentation, {
    footer1: "10",
    title: "AI 功能的最小界面组件：让用户不被“黑箱”困住",
    body1: threeBody("输入引导", "真实任务示例，而不是泛泛的“有什么可以帮你？”"),
    body2: threeBody("进度与停止", "生成可能慢；告诉用户当前阶段，保留停止入口。"),
    body3: threeBody("结果与证据", "结论、来源、时间、编辑、反馈、重试和版本记录。"),
  }));

  slides.push(make(buildSlide17, presentation, {
    footer1: "11",
    title: "从模型输出到稳定 UI：前端必须守住三道门",
    label1: "结构",
    label2: "权限",
    label3: "安全",
    body1: threeBody("固定契约", "用 JSON Schema / 结构化字段渲染卡片、表格和表单；不要切割随机文本。"),
    body2: threeBody("服务端裁决", "模型可以建议调用工具；真正的鉴权、写入、审计由服务端决定。"),
    body3: threeBody("不可信输入", "密钥不进浏览器；模型文本、外链、上传与工具返回都要校验。"),
  }));

  slides.push(make(buildSlide18, presentation, {
    footer1: "12",
    title: "课堂实战：销售异常分析助手",
    body1: threeBody("用户与任务", "门店经理，站会前 3 分钟。\n决定今天优先跟进哪一家门店。"),
    body2: threeBody("必须设计", "正常结果、加载、失败、发送前确认。\n支持查看证据和修正原因。"),
    body3: threeBody("小组交付", "一张需求卡 + 一个低保真界面 + 一次生成提示词。"),
    label1: "场景",
    label2: "状态",
    label3: "产出",
  }));

  slides.push(make(buildSlide02, presentation, {
    title: "每次交付前，问自己三个问题",
    title2: "课堂收束",
    title3: "用户知道下一步吗？\n结论能纠正吗？\n失败有出路吗？",
  }));

  console.log("slides-built");

  const sourceUrls = {
    general: [
      "Google PAIR — People + AI Guidebook: https://pair.withgoogle.com/guidebook-v2/",
      "Microsoft HAX — Guidelines for Human-AI Interaction: https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/",
    ],
    tools: [
      "Figma Make — Create and edit a functional prototype or web app: https://help.figma.com/hc/en-us/articles/31304485164695-Create-and-edit-a-functional-prototype-or-web-app",
      "Vercel — How to prompt v0: https://vercel.com/blog/how-to-prompt-v0",
      "Google AI Studio — Build apps: https://ai.google.dev/gemini-api/docs/aistudio-build-mode",
    ],
    output: [
      "OpenAI API Quickstart: https://platform.openai.com/docs/quickstart/make-your-first-api-request",
      "Google Gemini API — Prompt design strategies: https://ai.google.dev/gemini-api/docs/prompting-strategies",
    ],
  };

  addNotes(slides[0], sourceUrls.general);
  addNotes(slides[1], sourceUrls.general);
  addNotes(slides[2], [...sourceUrls.tools, ...sourceUrls.general]);
  addNotes(slides[3], sourceUrls.tools);
  addNotes(slides[4], [...sourceUrls.tools, ...sourceUrls.general]);
  addNotes(slides[5], sourceUrls.tools);
  addNotes(slides[6], sourceUrls.tools);
  addNotes(slides[7], sourceUrls.general);
  addNotes(slides[8], sourceUrls.general);
  addNotes(slides[9], sourceUrls.general);
  addNotes(slides[10], sourceUrls.output);
  addNotes(slides[11], sourceUrls.general);
  addNotes(slides[12], [...sourceUrls.general, ...sourceUrls.tools, ...sourceUrls.output]);

  console.log("notes-added");

  for (const [index, slide] of slides.entries()) {
    console.log(`render-${index + 1}`);
    const png = await presentation.export({ slide, format: "png", scale: 1 });
    await writeBlob(`${outputDir}/slide-${String(index + 1).padStart(2, "0")}.png`, png);
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(`${outputDir}/slide-${String(index + 1).padStart(2, "0")}.layout.json`, await layout.text());
  }
  const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
  await writeBlob(`${outputDir}/deck-montage.webp`, montage);
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(finalPptx);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
