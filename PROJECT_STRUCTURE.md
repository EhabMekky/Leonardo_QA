# Project Structure — Leonardo (MCP-Tester)

> **Leonardo** is a web-based QA automation tool that does AI exploratory testing with **Ollama** and **Playwright**.

```
MCP-Tester-main/
├── package.json                  # Root wrapper: forwards `start` / `dev` scripts to qa-tool
├── ollama.yaml                   # Ollama server config (host 127.0.0.1, port 11435)
├── .DS_Store                     # macOS metadata (can be ignored/deleted)
│
├── playwright-mcp-poc/           # Playwright MCP proof-of-concept (currently empty)
│
└── qa-tool/                      # Main application (Node.js, ES modules)
    ├── server.js                 # Express server entry point (API + static UI)
    ├── package.json              # Dependencies and scripts (start, dev)
    ├── package-lock.json
    ├── .env                      # Local environment variables (not committed)
    ├── .env.example              # Template for .env
    ├── .gitignore
    ├── server_crash.log          # Server crash log output
    │
    ├── src/
    │   ├── config.js             # Central app configuration
    │   │
    │   ├── engines/              # Core test execution engines
    │   │   ├── accessibility.js      # Accessibility audits (axe-core)
    │   │   ├── exploratory.js        # AI-driven exploratory testing (Ollama)
    │   │   ├── interaction-helper.js # Shared Playwright interaction helpers
    │   │   ├── scripted.js           # Scripted / CSV-driven test execution
    │   │   └── suite-runner.js       # Runs multiple test cases as a suite
    │   │
    │   ├── tests/                # Internal validation / verification scripts
    │   │   ├── get_login_element.js
    │   │   ├── validate-cross-browser.js
    │   │   ├── validate-emulation.js
    │   │   ├── validate-exploratory-modes.js
    │   │   ├── validate-frontend.js
    │   │   ├── verification-runner.js
    │   │   └── verify-failure.js
    │   │
    │   └── utils/                # Report generation
    │       ├── docx-generator.js     # Exports reports to Word (.docx)
    │       └── report-generator.js   # Generates HTML reports
    │
    ├── public/                   # Frontend (web UI served by Express)
    │   ├── index.html
    │   ├── app.js
    │   ├── favicon.svg
    │   ├── icon.jpg
    │   └── test-self-healing.html    # Test page for self-healing locators
    │
    ├── data/                     # Test cases and runtime data
    │   ├── checkout_e2e_test_case.csv
    │   ├── login_test_case.csv
    │   ├── registration_positive_test_case.csv
    │   ├── self_healing_test.csv
    │   ├── validation_failure.csv
    │   ├── locator-registry.json     # Stored locators for self-healing
    │   └── popup_analysis.json
    │
    ├── scripts/                  # Standalone helper / debugging scripts
    │   ├── dump-snippet.cjs
    │   ├── probe-elbata.js
    │   └── record-checkout-video.js
    │
    ├── reports/                  # Generated test run output
    │   └── run-<timestamp>/
    │       ├── index.html            # HTML report
    │       ├── meta.json             # Run metadata
    │       └── video-chrome.webm     # Recording of the run
    │
    ├── probe_*.html              # Saved page snapshots from probing
    │   (afterlogin, checkout, confirmation, index, login)
    ├── raw_confirmation.html     # Raw saved confirmation page
    │
    └── node_modules/             # Installed dependencies
```

## Key Dependencies

| Package | Purpose |
|---|---|
| `playwright` | Browser automation |
| `@axe-core/playwright` | Accessibility testing |
| `express` | Web server / API |
| `multer` | File uploads (CSV test cases) |
| `csv-parse` | Parsing CSV test cases |
| `docx` | Word report generation |

## Running

```bash
npm start      # from root (forwards to qa-tool) or inside qa-tool/
npm run dev    # watch mode
```

