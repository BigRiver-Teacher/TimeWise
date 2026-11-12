<div align="center">

# 🕒 知时 TimeWise

**一款主打「隐私安全」与「主动智能」的全栈多模态智能备忘录**

[![Vue 3](https://img.shields.io/badge/Vue-3.x-4fc08d?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Local_LLM-black?style=flat-square)](https://ollama.com/)

<p align="center">
  <i>告别繁琐记录，让 AI 帮你从杂乱的截图和文档中自动提取待办。</i>
</p>

</div>

---

## ✨ 项目背景与核心亮点 (Features)

传统的备忘录只能被动记录，而 **知时 TimeWise** 结合了前端 WebAssembly 解析技术与本地多模态大模型，实现了**从“杂乱信息”到“结构化待办”的自动化闭环**。

- **🔒 绝对隐私，全本地运行**：数据存储于本地 SQLite，AI 推理依赖本地 Ollama。**零云端传输**，断网亦可使用。
- **👁️ 多模态智能录入**：支持 PDF、Word、图片。前端利用 `pdfjs-dist` / `mammoth.js` 纯离线提取文字，配合本地视觉大模型（Qwen-VL）实现截图自动转录。
- **🧠 双 Agent 级联提取**：结合视觉模型（先做高精度 OCR 转 Markdown）与文本模型（深度结构化总结），将文档/截图自动清洗，并提取为多条结构化数据（任务名、时间、优先级、要点）。
- **⏰ NLP 时间引擎与分级提醒**：内置自研时间正则解析器，支持“明天下午3点”等自然语言。结合浏览器 Notification API 实现阶梯式系统级弹窗提醒。
- **🎨 现代高定 UI**：基于 Vue3 + Element Plus，采用 Design Tokens 打造，支持磨砂玻璃质感、动态渐变背景与深色模式。

---

## 🛠️ 技术栈 (Tech Stack)

| 分类 | 技术选型 |
| :--- | :--- |
| **前端核心** | Vue 3 (Composition API), TypeScript, Vite, Pinia, Vue Router |
| **UI 与图表** | Element Plus, ECharts, SCSS (Design Tokens) |
| **前端文档解析** | `pdfjs-dist`, `mammoth.js` (纯浏览器端解析) |
| **后端服务** | Node.js, Express, CORS |
| **数据持久化** | SQLite (`better-sqlite3`) |
| **本地 AI Agent** | Ollama (视觉模型: `qwen2.5vl:3b` / 文本模型: `qwen2.5:3b` 与 `qwen2.5:7b`) |

---

## 🚀 本地部署指南 (Local Deployment)

### 0. 环境准备
请确保你的电脑已安装：
- [Node.js](https://nodejs.org/) (建议 v18+)
- [Ollama](https://ollama.com/) (用于运行本地大模型)

### 1. 启动本地 AI Agent (Ollama)
打开终端，拉取并运行项目所需的模型（普通 16GB 内存的电脑即可流畅运行）：

```bash
# 拉取视觉大模型 (约 3.2GB，用于读取图片/文档截图，执行高精度 OCR)
ollama run qwen2.5vl:3b

# 拉取轻量文本大模型 (约 1.9GB，对应系统的“快速模式”)
ollama run qwen2.5:3b

# 拉取高精度文本大模型 (约 4.7GB，对应系统的“精准模式”，推荐下载)
ollama run qwen2.5:7b
```
# 2. 启动后端服务 (Node.js)
打开一个新的终端窗口，进入后端目录并运行：

```bash
cd server
npm install
node server.js
```
后端默认运行在 http://localhost:3000 。首次运行会自动在 server 目录下创建 memo.db 数据库文件。

# 3. 启动前端页面 (Vue3)
打开一个新的终端窗口，回到项目根目录并运行：

``` bash
npm install
npm run dev
```
打开浏览器访问终端提示的本地地址（如 http://localhost:5173 ）。
