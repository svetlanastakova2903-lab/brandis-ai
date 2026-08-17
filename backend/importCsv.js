// Импорт базы блогеров из выгрузки Tilda (CSV) в data/bloggers.json
// Использование: node importCsv.js /путь/к/выгрузке.csv
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Укажи путь к CSV: node importCsv.js /path/to/file.csv");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf-8");

const records = parse(raw, {
  delimiter: ";",
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
});

function platformUrl(nickRaw, platform) {
  const nick = (nickRaw || "").trim().replace(/^@/, "");
  if (!nick) return null;
  const p = (platform || "").toLowerCase();
  if (p.includes("инста")) return `https://instagram.com/${nick}`;
  if (p.includes("телег") || p.includes("telegram")) return `https://t.me/${nick}`;
  if (p.includes("tiktok") || p.includes("тикток")) return `https://www.tiktok.com/@${nick}`;
  if (p.includes("vk") || p.includes("вконтакте")) return `https://vk.com/${nick}`;
  if (p.includes("youtube") || p.includes("ютуб")) return `https://youtube.com/@${nick}`;
  return null;
}

function parseFollowers(text) {
  if (!text) return null;
  const m = text.replace(/\s/g, " ").match(/([\d\s]+)\s*подписчик/i);
  if (!m) return null;
  const num = parseInt(m[1].replace(/\D/g, ""), 10);
  return Number.isFinite(num) ? num : null;
}

function shortenNiches(nicheField) {
  if (!nicheField) return [];
  return nicheField
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim());
}

const bloggers = [];
let skipped = 0;

for (const row of records) {
  const category = (row["Category"] || "").trim();
  if (category !== "Блогеры") continue;

  const name = (row["Title"] || "").trim();
  const city = (row["Characteristics:Город"] || "").trim();
  const platform = (row["Characteristics:Платформа"] || "").trim();
  const nicheField = row["Characteristics:Сфера (тематика)"] || "";
  const text = row["Text"] || "";

  const followers = parseFollowers(text);
  const niches = shortenNiches(nicheField);
  const contact = platformUrl(name, platform);

  if (!name || !city) {
    skipped++;
    continue;
  }

  bloggers.push({
    name,
    city,
    niche: niches,
    followers: followers,
    platform: platform || null,
    price_from: null, // отсутствует в исходной выгрузке
    engagement: null, // отсутствует в исходной выгрузке
    contact: contact, // ссылка на соцсеть = прямой контакт
    profile_url: contact,
    photo: row["Photo"] || null,
  });
}

const outPath = path.join(__dirname, "data", "bloggers.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(bloggers, null, 2), "utf-8");

console.log(`Импортировано блогеров: ${bloggers.length}`);
console.log(`Пропущено (нет имени/города): ${skipped}`);
console.log(`Сохранено в: ${outPath}`);
