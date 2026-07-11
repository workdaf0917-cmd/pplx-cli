#!/usr/bin/env node
// pplx — Perplexity CLI that saves answers as Markdown to your Obsidian KB.
// Features: monthly USD budget, sonar-pro default, auto wiki/sources/ summary, wiki/log.md update.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Load .env from the project root (next to this file's parent dir) and from CWD.
import { config as loadEnv } from "dotenv";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(projectRoot, ".env") });
loadEnv(); // also load CWD .env if any (won't override existing)

const API_KEY = process.env.PPLX_API_KEY;
const MODEL = process.env.PPLX_MODEL || "sonar-pro";
const RAW_DIR = process.env.PPLX_RAW_DIR;
const WIKI_DIR = process.env.PPLX_WIKI_DIR;
const BUDGET = parseFloat(process.env.PPLX_MONTHLY_BUDGET_USD || "5");
const PRICE_IN = parseFloat(process.env.PPLX_PRICE_INPUT_PER_M || "3");
const PRICE_OUT = parseFloat(process.env.PPLX_PRICE_OUTPUT_PER_M || "15");
const PRICE_REQ = parseFloat(process.env.PPLX_PRICE_REQUEST_PER_K || "5");
const USAGE_FILE =
  process.env.PPLX_USAGE_FILE || path.join(os.homedir(), ".pplx", "usage.json");

// ---------------- CLI parsing ----------------
function parseArgs(argv) {
  const args = { _: [], format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--format" || a === "-f") args.format = argv[++i];
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--title" || a === "-t") args.title = argv[++i];
    else if (a === "--no-save") args.noSave = true;
    else if (a === "--print") args.print = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "usage") args.cmd = "usage";
    else if (a === "config") args.cmd = "config";
    else args._.push(a);
  }
  return args;
}

const HELP = `pplx — Perplexity CLI → Obsidian KB

Usage:
  pplx "<question>" [options]
  pplx usage                Show this month's API spend
  pplx config               Show resolved config

Options:
  -m, --model <name>        Model (default: ${MODEL})
  -f, --format <md|json>    Output format (default: md)
  -t, --title <text>        Custom title / file slug
  -o, --out <path>          Override output file path
      --print               Also print answer to stdout
      --no-save             Don't write file (just print)
  -h, --help                Show help

Env (.env at ${path.join(projectRoot, ".env")}):
  PPLX_API_KEY, PPLX_MODEL, PPLX_RAW_DIR, PPLX_WIKI_DIR,
  PPLX_MONTHLY_BUDGET_USD, PPLX_PRICE_*, PPLX_USAGE_FILE
`;

// ---------------- Usage ledger ----------------
function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveUsage(u) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function estimateCost({ inputTokens = 0, outputTokens = 0, requests = 1 }) {
  return (
    (inputTokens / 1_000_000) * PRICE_IN +
    (outputTokens / 1_000_000) * PRICE_OUT +
    (requests / 1_000) * PRICE_REQ
  );
}
function getMonthSpend(usage = loadUsage()) {
  const m = usage[monthKey()] || { input: 0, output: 0, requests: 0, cost: 0 };
  return m;
}

// ---------------- Slug & filenames ----------------
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    .replace(/[\/\\?%*:|"<>#]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------- Perplexity API ----------------
async function ask(question, model) {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a research assistant. Answer in clear Markdown with section headings, bullet points, and inline citations like [1] mapped to a Sources list at the end.",
        },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------- Markdown rendering ----------------
function renderMarkdown({ question, model, data, cost, slug, title }) {
  const choice = data.choices?.[0]?.message?.content?.trim() || "(empty)";
  const citations = data.citations || data.search_results || [];
  const usage = data.usage || {};
  const now = new Date();
  const iso = now.toISOString();

  const fm = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `query: "${question.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
    `model: ${model}`,
    `date: ${iso}`,
    `slug: ${slug}`,
    `tokens_in: ${usage.prompt_tokens ?? ""}`,
    `tokens_out: ${usage.completion_tokens ?? ""}`,
    `cost_usd: ${cost.toFixed(6)}`,
    "type: pplx-answer",
    "tags: [perplexity, raw]",
    "---",
    "",
  ].join("\n");

  let sources = "";
  if (citations.length) {
    sources =
      "\n\n## Sources\n" +
      citations
        .map((c, i) => {
          const url = typeof c === "string" ? c : c.url || c.link || "";
          const t = typeof c === "string" ? "" : c.title || "";
          return `${i + 1}. ${t ? `[${t}](${url})` : url}`;
        })
        .join("\n");
  }

  return `${fm}# ${title}\n\n> **Q:** ${question}\n\n${choice}${sources}\n`;
}

function renderSourceSummary({ title, slug, question, model, cost, rawPath, data }) {
  const choice = data.choices?.[0]?.message?.content?.trim() || "";
  const summary = choice.split("\n").slice(0, 8).join("\n");
  const iso = new Date().toISOString();
  const rel = path.relative(WIKI_DIR, rawPath).replace(/\\/g, "/");
  return [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source_type: perplexity`,
    `model: ${model}`,
    `date: ${iso}`,
    `cost_usd: ${cost.toFixed(6)}`,
    `raw: "${rel}"`,
    "tags: [source, perplexity]",
    "---",
    "",
    `# ${title}`,
    "",
    `**Query:** ${question}`,
    "",
    `**Raw answer:** [[${path.basename(rawPath, ".md")}]]`,
    "",
    "## Summary (top of answer)",
    "",
    summary,
    "",
  ].join("\n");
}

// ---------------- Main ----------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.cmd === "config") {
    console.log(
      JSON.stringify(
        {
          MODEL,
          RAW_DIR,
          WIKI_DIR,
          BUDGET,
          PRICE_IN,
          PRICE_OUT,
          PRICE_REQ,
          USAGE_FILE,
          API_KEY: API_KEY ? `set(${API_KEY.slice(0, 6)}…)` : "MISSING",
        },
        null,
        2
      )
    );
    return;
  }
  if (args.cmd === "usage") {
    const u = loadUsage();
    const m = getMonthSpend(u);
    console.log(`Month: ${monthKey()}`);
    console.log(`  Requests : ${m.requests}`);
    console.log(`  Tokens in: ${m.input}`);
    console.log(`  Tokens out: ${m.output}`);
    console.log(`  Spend    : $${(m.cost || 0).toFixed(4)} / $${BUDGET.toFixed(2)}`);
    return;
  }

  const question = args._.join(" ").trim();
  if (!question) {
    console.error("error: missing question\n");
    console.log(HELP);
    process.exit(2);
  }
  if (!API_KEY) {
    console.error(
      `error: PPLX_API_KEY not set. Edit ${path.join(projectRoot, ".env")}`
    );
    process.exit(1);
  }
  if (!RAW_DIR && !args.noSave && !args.out) {
    console.error("error: PPLX_RAW_DIR not set in .env");
    process.exit(1);
  }

  const model = args.model || MODEL;

  // Budget pre-check
  const usage = loadUsage();
  const month = getMonthSpend(usage);
  if (month.cost >= BUDGET) {
    console.error(
      `Budget exceeded: $${month.cost.toFixed(4)} / $${BUDGET.toFixed(
        2
      )} for ${monthKey()}. Edit PPLX_MONTHLY_BUDGET_USD or wait till next month.`
    );
    process.exit(3);
  }

  // Call API
  const data = await ask(question, model);
  const u = data.usage || {};
  const cost = estimateCost({
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    requests: 1,
  });

  // Update ledger
  const k = monthKey();
  usage[k] = usage[k] || { input: 0, output: 0, requests: 0, cost: 0 };
  usage[k].input += u.prompt_tokens || 0;
  usage[k].output += u.completion_tokens || 0;
  usage[k].requests += 1;
  usage[k].cost += cost;
  saveUsage(usage);

  // Build output
  const title = args.title || question.slice(0, 60);
  const slug = slugify(args.title || question);
  const stamp = timestamp();
  const filename = `${stamp}-${slug || "pplx"}.md`;

  if (args.format === "json") {
    const out = JSON.stringify(data, null, 2);
    if (args.print || args.noSave) console.log(out);
    if (!args.noSave) {
      const target = args.out || path.join(RAW_DIR, filename.replace(/\.md$/, ".json"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      console.error(`saved → ${target}`);
    }
  } else {
    const md = renderMarkdown({ question, model, data, cost, slug, title });
    if (args.print) console.log(md);

    if (!args.noSave) {
      const target = args.out || path.join(RAW_DIR, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, md);
      console.error(`saved → ${target}`);

      // wiki/sources/ summary + wiki/log.md
      if (WIKI_DIR) {
        const sourcesDir = path.join(WIKI_DIR, "sources");
        fs.mkdirSync(sourcesDir, { recursive: true });
        const sourcePage = path.join(sourcesDir, `${stamp}-${slug || "pplx"}.md`);
        fs.writeFileSync(
          sourcePage,
          renderSourceSummary({
            title,
            slug,
            question,
            model,
            cost,
            rawPath: target,
            data,
          })
        );
        console.error(`wiki  → ${sourcePage}`);

        const logPath = path.join(WIKI_DIR, "log.md");
        const logLine = `## [${new Date().toISOString()}] pplx | ${model} | $${cost.toFixed(
          4
        )} | [[${path.basename(sourcePage, ".md")}]]\n- Q: ${question.replace(
          /\n/g,
          " "
        )}\n- raw: [[${path.basename(target, ".md")}]]\n\n`;
        fs.appendFileSync(logPath, logLine);
        console.error(`log   → ${logPath}`);
      }
    }
  }

  console.error(
    `cost  $${cost.toFixed(6)}  | month $${(usage[k].cost).toFixed(
      4
    )} / $${BUDGET.toFixed(2)}`
  );
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
