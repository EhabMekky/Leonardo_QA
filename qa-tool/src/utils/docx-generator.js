import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBrowserModeLabel } from '../config.js';
import { 
  Document, 
  Packer, 
  Paragraph, 
  TextRun, 
  Table, 
  TableRow, 
  TableCell, 
  PageBreak, 
  ImageRun, 
  AlignmentType, 
  Header, 
  Footer, 
  PageNumber, 
  WidthType, 
  BorderStyle,
  HeadingLevel
} from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stylized Cell Border Definitions (Cool Grey Borders)
const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
};

// Helper: Create Table Header Cell (Deep Indigo Background, Calibri 11pt Bold, White Text)
function createHeaderCell(text, widthPercent) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text, bold: true, color: "ffffff", font: "Calibri", size: 22 })
        ],
        alignment: AlignmentType.LEFT,
      })
    ],
    shading: { fill: "1e293b" },
    margins: { top: 120, bottom: 120, left: 150, right: 150 },
    width: widthPercent ? { size: widthPercent, type: WidthType.PERCENTAGE } : undefined,
  });
}

// Helper: Create Standard Body Cell (Light Cool Grey or White Zebra Striped, Calibri 11pt, Dark Charcoal Text)
function createBodyCell(text, isZebra = false, isBold = false, widthPercent = null) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: text || "", font: "Calibri", size: 22, color: "334155", bold: isBold })
        ]
      })
    ],
    shading: { fill: isZebra ? "f8fafc" : "ffffff" },
    margins: { top: 100, bottom: 100, left: 150, right: 150 },
    borders: cellBorders,
    width: widthPercent ? { size: widthPercent, type: WidthType.PERCENTAGE } : undefined,
  });
}

// Helper: Create Cell with Multiple Lines (for sitemap heading hierarchy)
function createMultiLineCell(lines, isZebra = false) {
  const paragraphs = lines.map(line => {
    return new Paragraph({
      children: [
        new TextRun({ text: line, font: "Calibri", size: 22, color: "334155" })
      ],
      spacing: { after: 40 }
    });
  });

  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({
      children: [
        new TextRun({ text: "None detected", font: "Calibri", size: 22, italic: true, color: "64748b" })
      ]
    }));
  }

  return new TableCell({
    children: paragraphs,
    shading: { fill: isZebra ? "f8fafc" : "ffffff" },
    margins: { top: 100, bottom: 100, left: 150, right: 150 },
    borders: cellBorders
  });
}

/**
 * Generate a Microsoft Word (.docx) Business Feature Specification
 * @param {string} runId 
 * @param {Object} results 
 * @returns {string} Path to the generated docx file
 */
export async function generateDocxReport(runId, results) {
  const reportsDir = path.join(__dirname, '..', '..', 'reports', runId);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const sitemapMap = new Map(); // pathname -> { title, headings }
  const locatorsMap = new Map(); // pathname::selector -> locator object
  const allTransitions = [];

  const browsersData = results.browsers || {};
  for (const browserName of Object.keys(browsersData)) {
    const bData = browsersData[browserName];
    if (!bData || !bData.crawlResults) continue;

    const { sitemap = [], locators = [], transitions = [] } = bData.crawlResults;

    // 1. Merge sitemaps
    for (const [pathname, data] of sitemap) {
      const title = typeof data === 'string' ? data : (data.title || pathname);
      const headings = typeof data === 'string' ? [] : (data.headings || []);
      if (!sitemapMap.has(pathname) || (title && sitemapMap.get(pathname).title === pathname)) {
        sitemapMap.set(pathname, { title, headings });
      }
    }

    // 2. Merge locators
    for (const loc of locators) {
      const key = `${loc.page}::${loc.selector}`;
      if (!locatorsMap.has(key)) {
        locatorsMap.set(key, loc);
      }
    }

    // 3. Collect transitions
    transitions.forEach((t, index) => {
      allTransitions.push({
        browser: browserName,
        from: t.from,
        to: t.to,
        action: t.action,
        reason: t.reason,
        screenshot: t.screenshot
      });
    });
  }

  const documentChildren = [];

  // ==========================================
  // PAGE 1: COVER PAGE
  // ==========================================
  documentChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "WEBSITE BUSINESS SPECIFICATION & FUNCTIONAL INVENTORY",
          bold: true,
          size: 44, // 22pt
          color: "1e293b", // Deep Indigo
          font: "Calibri Light"
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 1800, after: 300 }
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: "Auto-Generated Site Specification & Business Feature Catalog",
          italic: true,
          size: 24, // 12pt
          color: "475569", // Slate Blue
          font: "Calibri"
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 1800 }
    }),
    // Horizontal divider table
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [],
              shading: { fill: "1e293b" },
              height: { value: 60, rule: "exact" },
              borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE }
              }
            })
          ]
        })
      ]
    }),
    new Paragraph({ spacing: { before: 600, after: 600 } }),
    // Metadata table
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            createHeaderCell("Audit Parameter", 30),
            createHeaderCell("Crawler Specification Detail", 70)
          ]
        }),
        new TableRow({
          children: [
            createBodyCell("Target URL", false, true),
            createBodyCell(results.url)
          ]
        }),
        new TableRow({
          children: [
            createBodyCell("Crawl Mode", true, true),
            createBodyCell("Business Auto-Doc Mode (High-Level Summary)", true)
          ]
        }),
        new TableRow({
          children: [
            createBodyCell("Crawl Date/Time", false, true),
            createBodyCell(new Date(results.startTime).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))
          ]
        }),
        new TableRow({
          children: [
            createBodyCell("AI Explorer Model", true, true),
            createBodyCell(results.model + " (Ollama)", true)
          ]
        }),
        new TableRow({
          children: [
            createBodyCell("Browser Executed", false, true),
            createBodyCell(Object.keys(browsersData).join(", ").toUpperCase() + ` (${getBrowserModeLabel()})`)
          ]
        })
      ]
    }),
    new PageBreak()
  );

  // ==========================================
  // PAGE 2: Site Sitemap
  // ==========================================
  documentChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "1. Site Sitemap & Route Inventory",
          bold: true,
          size: 32, // 16pt
          color: "1e293b",
          font: "Calibri Light"
        })
      ],
      spacing: { before: 200, after: 200 }
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: "Below is the list of unique page routes mapped by the AI crawler, along with their detected heading hierarchies.",
          font: "Calibri",
          size: 22, // 11pt
          color: "334155"
        })
      ],
      spacing: { after: 400 }
    })
  );

  // Build sitemap table
  const sitemapRows = [
    new TableRow({
      children: [
        createHeaderCell("No.", 8),
        createHeaderCell("Page Title", 27),
        createHeaderCell("Visited URL Pathname", 35),
        createHeaderCell("Heading Hierarchy Detected", 30)
      ]
    })
  ];

  let routeIndex = 1;
  for (const [pathname, data] of sitemapMap.entries()) {
    const isZebra = routeIndex % 2 === 0;
    const headingLines = (data.headings || []).map(h => `${h.tag}: "${h.text}"`);

    sitemapRows.push(
      new TableRow({
        children: [
          createBodyCell(routeIndex.toString() + ".", isZebra, false, 8),
          createBodyCell(data.title, isZebra, true, 27),
          createBodyCell(pathname, isZebra, false, 35),
          createMultiLineCell(headingLines, isZebra)
        ]
      })
    );
    routeIndex++;
  }

  documentChildren.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: sitemapRows
    }),
    new PageBreak()
  );

  // ==========================================
  // PAGE 3: BUSINESS FEATURE CATALOG
  // ==========================================
  documentChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "2. Business Feature Catalog (Functional Inventory)",
          bold: true,
          size: 32, // 16pt
          color: "1e293b",
          font: "Calibri Light"
        })
      ],
      spacing: { before: 200, after: 200 }
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: "A comprehensive catalog of major UI elements, components, and sections discovered on each page, written in plain business English describing their functional use and business value.",
          font: "Calibri",
          size: 22,
          color: "334155"
        })
      ],
      spacing: { after: 400 }
    })
  );

  // Build Business Feature Catalog Table
  const catalogRows = [
    new TableRow({
      children: [
        createHeaderCell("Page Name", 20),
        createHeaderCell("Feature/Component", 25),
        createHeaderCell("Functional Description", 30),
        createHeaderCell("Business / User Value", 25)
      ]
    })
  ];

  let locatorIndex = 1;
  for (const loc of locatorsMap.values()) {
    const isZebra = locatorIndex % 2 === 0;
    const pageDisplay = `${loc.page}`;
    const featureDisplay = loc.featureName || loc.name || loc.placeholder || "Interactive Element";
    const descDisplay = loc.functionalDescription || "Allows user interaction.";
    const valueDisplay = loc.businessValue || "Improves usability.";

    catalogRows.push(
      new TableRow({
        children: [
          createBodyCell(pageDisplay, isZebra, true, 20),
          createBodyCell(featureDisplay, isZebra, false, 25),
          createBodyCell(descDisplay, isZebra, false, 30),
          createBodyCell(valueDisplay, isZebra, false, 25)
        ]
      })
    );
    locatorIndex++;
  }

  if (locatorsMap.size === 0) {
    catalogRows.push(
      new TableRow({
        children: [
          createBodyCell("None found", false, false, 100),
          createBodyCell("", false, false),
          createBodyCell("", false, false),
          createBodyCell("", false, false)
        ]
      })
    );
  }

  documentChildren.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: catalogRows
    }),
    new PageBreak()
  );

  // ==========================================
  // PAGE 4: USER JOURNEY & WALKTHROUGH
  // ==========================================
  documentChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "3. User Journey & Visual Walkthrough",
          bold: true,
          size: 32, // 16pt
          color: "1e293b",
          font: "Calibri Light"
        })
      ],
      spacing: { before: 200, after: 200 }
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: "Below is the detailed visual walkthrough representing the exact sequence of navigations and actions triggered during exploration, along with functional intents and screenshot proofs.",
          font: "Calibri",
          size: 22,
          color: "334155"
        })
      ],
      spacing: { after: 400 }
    })
  );

  // Output steps
  let stepIndex = 1;
  for (const t of allTransitions) {
    documentChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Step ${stepIndex}: ${t.action}`,
            bold: true,
            size: 24, // 12pt
            color: "1e293b",
            font: "Calibri Light"
          })
        ],
        spacing: { before: 300, after: 100 }
      })
    );

    if (t.reason) {
      documentChildren.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Functional Intent: ", bold: true, color: "334155", size: 22, font: "Calibri" }),
            new TextRun({ text: `"${t.reason}"`, italic: true, color: "334155", size: 22, font: "Calibri" })
          ],
          spacing: { after: 100 }
        })
      );
    }

    documentChildren.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Flow Transition: ", bold: true, color: "334155", size: 22, font: "Calibri" }),
          new TextRun({ text: `\`${t.from}\`  ⟶  \`${t.to}\`   [Browser: ${t.browser.toUpperCase()}]`, font: "Courier New", size: 18, color: "475569" })
        ],
        spacing: { after: 150 }
      })
    );

    // Embed screenshot image inside a table to add a subtle gray border
    if (t.screenshot) {
      try {
        const imageBuffer = Buffer.from(t.screenshot, 'base64');
        documentChildren.push(
          new Table({
            alignment: AlignmentType.CENTER,
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new ImageRun({
                            data: imageBuffer,
                            transformation: {
                              width: 500,
                              height: 281 // 16:9 ratio
                            }
                          })
                        ],
                        alignment: AlignmentType.CENTER
                      })
                    ],
                    borders: {
                      top: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
                      bottom: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
                      left: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" },
                      right: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" }
                    },
                    margins: { top: 60, bottom: 60, left: 60, right: 60 }
                  })
                ]
              })
            ]
          })
        );
        // spacer after image
        documentChildren.push(new Paragraph({ spacing: { before: 200 } }));
      } catch (imgErr) {
        console.warn(`Failed to parse screenshot for step ${stepIndex}: ${imgErr.message}`);
      }
    }

    documentChildren.push(
      new Paragraph({
        children: [
          new TextRun({ text: "━".repeat(45), color: "cbd5e1" })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 150, after: 200 }
      })
    );
    stepIndex++;
  }

  // Compile final document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              bottom: 1440,
              left: 1440,
              right: 1440,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ 
                    text: `${results.url}   |   ${new Date(results.startTime).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, 
                    size: 16, 
                    color: "475569",
                    font: "Calibri"
                  })
                ],
                alignment: AlignmentType.RIGHT,
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "Page ", size: 16, color: "475569", font: "Calibri" }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    color: "475569",
                    font: "Calibri"
                  }),
                ],
                alignment: AlignmentType.CENTER,
              })
            ]
          })
        },
        children: documentChildren
      }
    ]
  });

  // Write file to disk
  const outputPath = path.join(reportsDir, 'documentation-spec.docx');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  
  console.log(`✅ Word specification compiled successfully: ${outputPath}`);
  return outputPath;
}
