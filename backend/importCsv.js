// Импорт базы блогеров и брендов из выгрузки Tilda (CSV) в data/bloggers.json и data/brands.json
// Использование: node importCsv.js /путь�/к/выгрузке.csv
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

function parsePhone(text) {
  if (!text) return null;
  const cleaned = text.replace(/<br\s*\/?>/gi, " ");
  const m = cleaned.match(/\+?\d[\d\s()\-]{8,}\d/);
  return m ? m[0].trim() : null;
}

function shortenNiches(nicheField) {
  if (!nicheField) return [];
  return nicheField
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim());
}

function stripHtml(text) {
  if (!text) return null;
  return text.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim() || null;
}

const bloggers = [];
const brands = [];
let skippedBloggers = 0;
let skippedBrands = 0;

for (const row of records) {
  const category = (row["Category"] || "").trim();
  const name = (row["Title"] || "").trim();
  const city = (row["Characteristics:Город"] || "").trim();
  const nicheField = row["Characteristics:Сфера (тематика)"] || "";
  const text = row["Text"] || "";
  const niches = shortenNiches(nicheField);

  if (category === "Блогеры") {
    const platform = (row["Characteristics:Платформа"] || "").trim();
    const followers = parseFollowers(text);
    const contact = platformUrl(name, platform);

    if (!name || !city) {
      skippedBloggers++;
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
      // Возможные значения: paid_collab (реклама за деньги), barter (готов на бартер),
      // cross_promo_with_blogger (кросс-промо с другим блогером). По умолчанию считаем,
      // что блогер открыт к платным коллабам — в исходной выгрузке этого поля нет.
      looking_for: ["paid_collab"],
      barter_interest: null, // чего хочет взамен бартером — нет в исходной выгрузке
      contact: contact, // ссылка на соцсеть = прямой контакт
      profile_url: contact,
      photo: row["Photo"] || null,
    });
  } else if (category === "Бренды") {
    const phone = parsePhone(text);
    const description = stripHtml(text);

    if (!name || !city) {
      skippedBrands++;
      continue;
    }

    brands.push({
      name,
      city,
      niche: niches,
      offer_type: "деньги", // не указано в исходной выгрузке, деньги — дефолт по умолчанию
      budget_from: null, // отсутствует в исходной выгрузке
      contact: phone,
      description,
    });
  }
}

const bloggersOut = path.join(__dirname, "data", "bloggers.json");
const brandsOut = path.join(__dirname, "data", "brands.json");
fs.mkdirSync(path.dirname(bloggersOut), { recursive: true });
fs.writeFileSync(bloggersOut, JSON.stringify(bloggers, null, 2), "utf-8");
fs.writeFileSync(brandsOut, JSON.stringify(brands, null, 2), "utf-8");

console.log(`Импортировано блогеров: ${bloggers.length} (пропущено: ${skippedBloggers})`);
console.log(`Импортировано брендов: ${brands.length} (пропущено: ${skippedBrands})`);
console.log(`Сохранено в: ${bloggersOut}`);
console.log(`Сохранено в: ${brandsOut}`);
