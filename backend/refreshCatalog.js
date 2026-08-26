// Еженедельное обновление базы блогеров и брендов напрямую из живого каталога Тильды
// (brandisapp.ru/catalog), без ручного экспорта CSV.
//
// Использует публичный (без авторизации) JSON API, который сама Тильда использует для
// отрисовки каталога на сайте: store.tildaapi.com/api/getproductslist. Перебирает
// страницы для категорий "Блогеры" и "Бренды" и полностью перезаписывает
// data/bloggers.json и data/brands.json актуальным содержимым каталога на сегодня.
//
// Запуск: node refreshCatalog.js
// Обычно запускается по расписанию (см. Render Cron Job "brandis-catalog-refresh",
// по пятницам) — тогда обновлённые файлы дальше нужно закоммитить и запушить в GitHub,
// это делает оборачивающий скрипт refreshCatalog.sh.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT_PARTUID = 966155984312;
const RECID = 1241984746;
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // страховка от бесконечного цикла, если API поменяет формат

async function fetchCategoryPage(categoryLabel, page) {
  const params = new URLSearchParams({
    storepartuid: String(ROOT_PARTUID),
    recid: String(RECID),
    getparts: "false",
    getoptions: "false",
    size: String(PAGE_SIZE),
    // Постранично API листает параметром slice, а не p: с "p" он молча отдаёт первую
    // страницу снова и снова, и обход обрывался на первой сотне карточек.
    slice: String(page),
    flag_root: "withroot",
  });
  params.append("filters[storepartuid][0]", categoryLabel);

const url = `https://store.tildaapi.com/api/getproductslist/?${params.toString()}`;
  // Tilda отдаёт 403 без правдоподобных браузерных заголовков (Referer/Origin/User-Agent) —
// API формально публичный, но проверяет, что запрос похож на запрос с самого сайта.
const res = await fetch(url, {
  headers: {
    Accept: "application/json",
    Referer: "https://brandisapp.ru/catalog",
    Origin: "https://brandisapp.ru",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
});
  if (!res.ok) {
    throw new Error(`Tilda API ответил ${res.status} для "${categoryLabel}", страница ${page}`);
  }
  return res.json();
}

async function fetchAllProducts(categoryLabel) {
  const all = [];
  const seenUids = new Set();
  let page = 1;
  let total = null;

while (page <= MAX_PAGES) {
  const data = await fetchCategoryPage(categoryLabel, page);
  if (total === null) total = data.total;
  const products = data.products || [];
  if (products.length === 0) break;

  let addedNew = false;
  for (const p of products) {
    if (seenUids.has(p.uid)) continue;
    seenUids.add(p.uid);
    all.push(p);
    addedNew = true;
  }
  // Если страница вернула только уже виденные карточки — либо дошли до конца,
  // либо API зациклилось; в любом случае останавливаемся.
  if (!addedNew) break;
  if (all.length >= total) break;
  page++;
}

return { products: all, total };
}

function getCharacteristicValues(product, title) {
  return (product.characteristics || [])
  .filter((c) => c.title === title)
  .map((c) => c.value)
  .filter(Boolean);
}

// Города люди пишут руками, поэтому в каталоге живут «Санкт- Петербург», «спб» и двойные
// пробелы — и один и тот же город распадается на несколько разных фильтров. Приводим к
// одному написанию: убираем лишние пробелы (в том числе вокруг дефиса) и разворачиваем
// самые частые сокращения. Ничего не выдумываем — только нормализуем то, что уже есть.
const CITY_ALIASES = new Map([
  ["спб", "Санкт-Петербург"],
  ["с-пб", "Санкт-Петербург"],
  ["питер", "Санкт-Петербург"],
  ["saint petersburg", "Санкт-Петербург"],
  ["saint-petersburg", "Санкт-Петербург"],
  ["st petersburg", "Санкт-Петербург"],
  ["spb", "Санкт-Петербург"],
  ["мск", "Москва"],
  ["moscow", "Москва"],
  ["екб", "Екатеринбург"],
  ["нижний новгород", "Нижний Новгород"],
  ["нн", "Нижний Новгород"],
]);

function normalizeCity(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .replace(/[.,;]+$/, "");
  if (!cleaned) return null;
  const alias = CITY_ALIASES.get(cleaned.toLowerCase());
  if (alias) return alias;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function shortenNiches(rawNiches) {
  return rawNiches.map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean);
}

function normalizeUrl(link) {
  if (!link) return null;
  const trimmed = link.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseFollowers(descr) {
  if (!descr) return null;
  const m = descr.replace(/ /g, " ").match(/([\d\s.,]+)\s*(тыс\.?)?\s*подписч/i);
  if (!m) return null;
  const numStr = m[1].replace(/\s/g, "").replace(",", ".");
  let num = parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  if (m[2]) num *= 1000;
  return Math.round(num);
}

function transformBlogger(product) {
  const cities = getCharacteristicValues(product, "Город").map(normalizeCity).filter(Boolean);
  const niches = shortenNiches(getCharacteristicValues(product, "Сфера (тематика)"));
  const platforms = getCharacteristicValues(product, "Платформа");
  const photo =
    (() => {
      try {
        const gallery = JSON.parse(product.gallery || "[]");
        return gallery[0]?.img || null;
      } catch {
        return null;
      }
    })() || product.editions?.[0]?.img || null;
  const contact = normalizeUrl(product.buttonlink || product.url);

const name = (product.title || "").trim();
  const city = cities.join(";");
  // Раньше карточку без города выбрасывали (наследие CSV-импорта) — и 65 живых блогеров
  // просто не существовали для ИИ. Город — полезный фильтр, но не повод удалять человека
  // из базы: оставляем с city = null, а модель предупреждена, что город неизвестен.
  if (!name) return null;

return {
  name,
  city: city || null,
  niche: niches,
  followers: parseFollowers(product.descr),
  platform: platforms[0] || null,
  // Условия сотрудничества (деньги / бартер / кросс-промо), цену и вовлечённость мы у людей
  // не спрашиваем — в каталоге таких полей нет. Раньше здесь стояли выдуманные значения,
  // и модель на них ссылалась как на факт. Лучше не знать, чем знать неправду.
  contact,
  profile_url: contact,
  photo,
};
}

function transformBrand(product) {
  const cities = getCharacteristicValues(product, "Город").map(normalizeCity).filter(Boolean);
  const niches = shortenNiches(getCharacteristicValues(product, "Сфера (тематика)"));
  const contact = normalizeUrl(product.buttonlink || product.url);

const name = (product.title || "").trim();
  const city = cities.join(";");
  if (!name) return null;

return {
  name,
  city: city || null,
  niche: niches,
  // Раньше контактом был телефон, распарсенный из полного CSV-экспорта (поле Text).
  // Открытый API Тильды такого текста не отдаёт, зато у карточки бренда почти всегда
  // есть ссылка (сайт/соцсеть) — используем её, это не хуже как способ связаться.
  contact,
};
}

// Экспортируем сборку каталога отдельно от записи файлов: сервер зовёт её на старте и
// по таймеру, чтобы держать базу в памяти свежей, не дожидаясь коммита новых JSON.
export async function fetchCatalog() {
  const [{ products: bloggerProducts, total: bloggersTotal }, { products: brandProducts, total: brandsTotal }] =
    await Promise.all([fetchAllProducts("Блогеры"), fetchAllProducts("Бренды")]);
  return {
    bloggers: bloggerProducts.map(transformBlogger).filter(Boolean),
    brands: brandProducts.map(transformBrand).filter(Boolean),
    bloggersTotal,
    brandsTotal,
  };
}

async function main() {
  console.log("Тяну актуальный каталог блогеров с brandisapp.ru...");
  const { products: bloggerProducts, total: bloggersTotal } = await fetchAllProducts("Блогеры");
  console.log(`Получено карточек блогеров: ${bloggerProducts.length} (в каталоге заявлено: ${bloggersTotal})`);

console.log("Тяну актуальный каталог брендов с brandisapp.ru...");
  const { products: brandProducts, total: brandsTotal } = await fetchAllProducts("Бренды");
  console.log(`Получено карточек брендов: ${brandProducts.length} (в каталоге заявлено: ${brandsTotal})`);

const bloggers = bloggerProducts.map(transformBlogger).filter(Boolean);
  const brands = brandProducts.map(transformBrand).filter(Boolean);

const skippedBloggers = bloggerProducts.length - bloggers.length;
  const skippedBrands = brandProducts.length - brands.length;

const bloggersOut = path.join(__dirname, "data", "bloggers.json");
  const brandsOut = path.join(__dirname, "data", "brands.json");
  fs.mkdirSync(path.dirname(bloggersOut), { recursive: true });
  fs.writeFileSync(bloggersOut, JSON.stringify(bloggers, null, 2), "utf-8");
  fs.writeFileSync(brandsOut, JSON.stringify(brands, null, 2), "utf-8");

console.log(`Сохранено блогеров: ${bloggers.length} (пропущено без города/имени: ${skippedBloggers}) -> ${bloggersOut}`);
  console.log(`Сохранено брендов: ${brands.length} (пропущено без города/имени: ${skippedBrands}) -> ${brandsOut}`);

// Немного статистики для лога — удобно сверять с реальным каталогом на сайте.
if (bloggers.length < bloggersTotal * 0.5) {
  console.warn(
    `ВНИМАНИЕ: сохранили меньше половины от заявленного числа блогеров (${bloggers.length} из ${bloggersTotal}). ` +
    `Возможно, у Тильды поменялся формат API — стоит проверить руками.`
    );
}
}

// Файл теперь ещё и модуль (сервер импортирует fetchCatalog), поэтому main() запускаем
// только когда скрипт вызвали напрямую: node refreshCatalog.js
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Ошибка обновления каталога:", err);
    process.exit(1);
  });
}
