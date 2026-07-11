#!/usr/bin/env node
/**
 * scan-skills — 掃描所有已安裝 agent skills，生成索引
 * 
 * 輸出：
 *   1. ~/.skills-index.json（機器可讀）
 *   2. wiki/tools/skill-catalog.md（Obsidian 人類可讀）
 * 
 * 用法：scan-skills [--quiet]
 */

import { readdir, readFile, writeFile, stat, mkdir } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const QUIET = process.argv.includes('--quiet');

// 所有已知 skill 目錄
const SKILL_DIRS = [
  { agent: 'Claude Code', path: join(HOME, '.claude/skills') },
  { agent: 'Claude Code', path: join(HOME, '.agents/skills') },
  { agent: 'Codex', path: join(HOME, '.codex/skills') },
  { agent: 'Cursor', path: join(HOME, '.cursor/skills') },
  { agent: 'Windsurf', path: join(HOME, '.codeium/windsurf/skills') },
  { agent: 'Gemini CLI', path: join(HOME, '.gemini/skills') },
  { agent: 'OpenCode', path: join(HOME, '.config/opencode/skills') },
  { agent: 'Hermes Agent', path: join(HOME, '.hermes/skills') },
  { agent: 'Goose', path: join(HOME, '.config/goose/skills') },
  { agent: 'Roo', path: join(HOME, '.roo/skills') },
  { agent: 'Kiro', path: join(HOME, '.kiro/skills') },
];

// Obsidian KB 路徑（可由環境變數覆蓋）
const WIKI_TOOLS = process.env.PPLX_WIKI_DIR
  ? join(process.env.PPLX_WIKI_DIR, 'tools')
  : join(
      HOME,
      'Library/Mobile Documents/iCloud~md~obsidian/Documents/Perplexity知識庫/wiki/tools'
    );

// 解析 SKILL.md frontmatter
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // 去引號
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      fm[key] = val;
    }
  }
  return fm;
}

// 提取 description（frontmatter 或首段文字）
function extractDescription(content) {
  const fm = parseFrontmatter(content);
  if (fm.description) return fm.description;
  // 找第一個非空行（跳過 frontmatter 和 #）
  const body = content.replace(/^---[\s\S]*?---\n?/, '');
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.slice(0, 120);
    }
  }
  return '(no description)';
}

// 提取觸發關鍵字（從 description + name 推斷）
function extractTriggers(name, description) {
  const triggers = [name];
  // 常見詞映射
  const keywords = description.toLowerCase() + ' ' + name.toLowerCase();
  const map = {
    'frontend': ['前端', 'UI', 'web design', 'CSS', 'React'],
    'design': ['設計', 'UI/UX', 'layout'],
    'mcp': ['MCP', 'Model Context Protocol', 'tool server'],
    'crew': ['multi-agent', '多 agent', '協作', 'orchestration'],
    'obsidian': ['Obsidian', '知識庫', 'vault', 'wiki'],
    'audit': ['稽核', '檢查', 'audit', 'lint'],
    'knowledge': ['知識', 'KB', 'knowledge base'],
    'graph': ['圖譜', 'knowledge graph', '視覺化'],
    'notebook': ['NotebookLM', 'podcast', '簡報', 'audio'],
    'screenshot': ['截圖', 'screenshot', '螢幕'],
    'pdf': ['PDF', '文件'],
    'playwright': ['測試', 'e2e', 'browser test'],
    'sora': ['影片', 'video', '生成'],
    'notion': ['Notion', '筆記'],
    'engineer': ['工程', '參數', '規範', '水利'],
    'pump': ['抽水站', 'pump', '擴容'],
    'skill': ['skill', '技能', '建立 skill'],
    'water': ['水利', '台水', 'TWC'],
  };
  for (const [key, vals] of Object.entries(map)) {
    if (keywords.includes(key)) {
      triggers.push(...vals);
    }
  }
  return [...new Set(triggers)];
}

async function scanDir(agent, dirPath) {
  const results = [];
  try {
    const entries = await readdir(dirPath);
    for (const entry of entries) {
      const skillDir = join(dirPath, entry);
      const st = await stat(skillDir).catch(() => null);
      if (!st || !st.isDirectory()) continue;

      // 尋找 SKILL.md
      const skillFile = join(skillDir, 'SKILL.md');
      let content = '';
      try {
        content = await readFile(skillFile, 'utf-8');
      } catch {
        // 嘗試 README.md
        try {
          content = await readFile(join(skillDir, 'README.md'), 'utf-8');
        } catch {
          content = '';
        }
      }

      const fm = parseFrontmatter(content);
      const name = fm.name || entry;
      const description = extractDescription(content);
      const triggers = extractTriggers(name, description);

      results.push({
        name,
        agent,
        path: skillDir,
        description,
        triggers,
        hasSkillMd: content.length > 0,
      });
    }
  } catch {
    // 目錄不存在，跳過
  }
  return results;
}

async function main() {
  const allSkills = [];

  for (const { agent, path } of SKILL_DIRS) {
    const found = await scanDir(agent, path);
    allSkills.push(...found);
  }

  // 去重（同名 skill 可能在多個 agent 目錄）
  const deduped = new Map();
  for (const s of allSkills) {
    const key = s.name;
    if (deduped.has(key)) {
      const existing = deduped.get(key);
      if (!existing.agents) existing.agents = [existing.agent];
      existing.agents.push(s.agent);
    } else {
      deduped.set(key, { ...s, agents: [s.agent] });
    }
  }

  const skills = [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));

  // 1. 寫 JSON 索引
  const indexPath = join(HOME, '.skills-index.json');
  const indexData = {
    generated: new Date().toISOString(),
    count: skills.length,
    skills: skills.map(s => ({
      name: s.name,
      agents: s.agents,
      description: s.description,
      triggers: s.triggers,
      path: s.path,
    })),
  };
  await writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf-8');

  // 2. 寫 Obsidian catalog
  await mkdir(WIKI_TOOLS, { recursive: true });
  const catalogPath = join(WIKI_TOOLS, 'skill-catalog.md');

  let md = `---
title: Skill Catalog（自動生成）
type: tool-reference
created: 2026-05-19
updated: ${new Date().toISOString().slice(0, 10)}
tags: [工具, skills, catalog, 自動生成]
---

# Skill Catalog

> ⚙️ 此頁由 \`scan-skills\` 自動生成，勿手動編輯。  
> 上次掃描：${new Date().toISOString()}  
> 已索引：**${skills.length} 個 skills**

---

## 快速查找

| Skill | Agent(s) | 說明 | 觸發情境 |
|-------|----------|------|---------|
`;

  for (const s of skills) {
    const agents = s.agents.join(', ');
    const desc = s.description.replace(/\|/g, '\\|').slice(0, 60);
    const triggers = s.triggers.slice(0, 5).join(', ');
    md += `| **${s.name}** | ${agents} | ${desc} | ${triggers} |\n`;
  }

  md += `
---

## 按 Agent 分組

`;

  const byAgent = {};
  for (const s of allSkills) {
    if (!byAgent[s.agent]) byAgent[s.agent] = [];
    byAgent[s.agent].push(s);
  }

  for (const [agent, list] of Object.entries(byAgent).sort()) {
    md += `### ${agent}\n`;
    for (const s of list.sort((a, b) => a.name.localeCompare(b.name))) {
      md += `- **${s.name}** — ${s.description.slice(0, 80)}\n`;
    }
    md += '\n';
  }

  md += `---

## 使用方式

- **人工查閱**：在 Obsidian 搜尋此頁
- **Agent 推薦**：agent 讀取 \`~/.skills-index.json\` 或 \`skill-recommender\` skill 自動匹配
- **更新索引**：\`scan-skills\`（安裝/移除 skill 後執行一次）

## 相關
- [[skills-cli-指令清單]]
`;

  await writeFile(catalogPath, md, 'utf-8');

  if (!QUIET) {
    console.log(`✅ 掃描完成：${skills.length} 個 skills`);
    console.log(`   索引 → ${indexPath}`);
    console.log(`   目錄 → ${catalogPath}`);
  }
}

main().catch(err => {
  console.error('scan-skills error:', err.message);
  process.exit(1);
});
