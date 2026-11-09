# 🎨 Leonardo — AI-Powered QA Automation Tool

**Leonardo** is a web-based QA automation tool. It combines **Playwright** browser automation with **local AI models via Ollama**. You can run scripted tests from CSV files, describe test suites in plain English, run accessibility audits, or let the AI explore your web app on its own to find bugs.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.12-339933?logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?logo=playwright&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-Local%20AI-000000)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ Features

- **📋 Scripted Testing**: Upload or write CSV test cases (`Step, Test Data, Result`) and run them step by step.
- **🧩 Suite Mode**: Write test cases in natural language. The AI turns them into executable steps.
- **🤖 AI Exploratory Testing**: An Ollama model drives the browser by itself. It has two modes:
  - **Bug Hunting Mode**: actively looks for defects.
  - **Business Auto-Doc Mode**: explores the app and documents business flows.
- **♿ Accessibility Audits**: WCAG checks powered by `axe-core`.
- **🩹 Self-Healing Locators**: A locator registry recovers when selectors change.
- **🌐 Cross-Browser**: Chrome, Firefox, and Microsoft Edge.
- **📱 Device Emulation**: Desktop and mobile device profiles.
- **🍪 Cookie Injection**: Test authenticated pages by supplying session cookies.
- **📊 Rich Reports**: HTML reports with run metadata and **video recordings**, plus **Word (.docx)** export.
- **⏹️ Live Control**: Track test status in real time and cancel running tests.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Automation | Playwright |
| AI | Ollama (default model: `qwen2.5-coder:7b`) |
| Accessibility | `@axe-core/playwright` |
| Reports | HTML, `docx` |
| Uploads / Parsing | `multer`, `csv-parse` |
| Frontend | Vanilla HTML / CSS / JavaScript |

---

## 📦 Prerequisites

- [Node.js](https://nodejs.org/) **v20.12 or newer** (needed for the built-in `.env` loading)
- [Ollama](https://ollama.com/) (needed for AI exploratory and suite modes)
- Microsoft Edge (optional, only needed for Edge tests)

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/EhabMekky/MCP-Tester-main.git
cd MCP-Tester-main/qa-tool
```

### 2. Install dependencies

```bash
npm install
npx playwright install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` as needed:

```env
# Server
PORT=3000

# Ollama (AI exploratory testing)
OLLAMA_URL=http://127.0.0.1:11434

# Browser
HEADLESS=false   # true = no visible browser window (CI-friendly)
SLOW_MO=         # delay in ms between actions (empty = engine default)
```

### 4. Pull an AI model (for AI features)

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

### 5. Run the app

```bash
npm start        # production
npm run dev      # watch mode (auto-restart)
```

You can also run `npm start` from the repository root.

Then open **http://localhost:3000** in your browser.

---

## 📝 Writing Test Cases (CSV)

Test cases use a simple 3-column CSV format:

```csv
Step,Test Data,Result
1. Navigate to the login page,,The login page is displayed with Username and Password fields.
2. Enter Username,standard_user,The username is entered in the Username field.
3. Enter Password,secret_sauce,The password is entered (masked).
4. Click the Login button,,The user is redirected to the inventory page.
```

You can find more examples in [`qa-tool/data/`](qa-tool/data/).

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/ollama-status` | Check whether Ollama is running |
| `GET` | `/api/ollama-models` | List available Ollama models |
| `GET` | `/api/reports` | List generated reports |
| `POST` | `/run-test` | Start a test run (CSV upload, text, exploratory, or accessibility) |
| `POST` | `/cancel-test` | Cancel a running test |
| `GET` | `/test-status/:id` | Get live status of a test run |
| `GET` | `/report/:id` | View a generated report |

---

## 📁 Project Structure

```
MCP-Tester/
├── package.json              # Root wrapper → forwards scripts to qa-tool
├── ollama.yaml               # Ollama server config
└── qa-tool/
    ├── server.js             # Express server entry point
    ├── .env.example          # Environment template
    ├── src/
    │   ├── config.js         # Centralized runtime config
    │   ├── engines/          # scripted, suite, exploratory, accessibility
    │   ├── tests/            # Internal validation scripts
    │   └── utils/            # HTML & DOCX report generators
    ├── public/               # Web UI
    ├── data/                 # Sample CSV test cases & locator registry
    ├── scripts/              # Helper / debugging scripts
    └── reports/              # Generated test reports (HTML, JSON, video)
```

See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for the full breakdown.

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push the branch: `git push origin feature/my-feature`
5. Open a Pull Request.

---

## 📄 License

This project is licensed under the **MIT License**.

---

## 👤 Author

**Ehab Mohamed**

⭐ If you find this project useful, consider giving it a star!

