// server/index.ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// server/api-server.ts
import { createServer } from "node:http";
import { isIP } from "node:net";

// src/tmapi-catalog.ts
function row(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function plain(value, limit = 1e3) {
  if (typeof value !== "string") return "";
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function numeric(value, allowZero = false) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= (allowZero ? 0 : Number.MIN_VALUE) && result <= Number.MAX_SAFE_INTEGER ? result : null;
}
function integer(value, allowZero = false) {
  const result = numeric(value, allowZero);
  return result !== null && Number.isSafeInteger(result) ? result : null;
}
function identifier(value) {
  const result = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return /^\d{1,32}$/.test(result) && !/^0+$/.test(result) ? result : null;
}
function safeImage(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
function images(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 200).flatMap((entry) => {
    const image = safeImage(entry);
    return image ? [image] : [];
  }))];
}
function responseData(payload) {
  const root = row(payload);
  if (!root || root.code !== void 0 && Number(root.code) !== 200) return null;
  return row(root.data) ?? (root.item_id !== void 0 ? root : null);
}
function tmapiDescriptionImages(payload, sourceId) {
  const root = row(payload);
  const data = row(root?.data);
  if (Number(root?.code) !== 200 || identifier(data?.item_id) !== sourceId || !Array.isArray(data?.detail_imgs)) return null;
  return images(data.detail_imgs);
}
function attributes(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const entry of value.slice(0, 500)) {
    const object2 = row(entry);
    if (!object2) continue;
    const pairs = typeof object2.name === "string" && object2.value !== void 0 ? [[object2.name, object2.value]] : Object.entries(object2);
    for (const [key, raw] of pairs) {
      const name = plain(key, 120);
      const value2 = plain(typeof raw === "number" ? String(raw) : raw, 1e3);
      if (name && value2) result.push({ name, value: value2 });
    }
  }
  return result;
}
function explicitWeight(value, declaredUnit) {
  const unitMatch = typeof value === "string" ? value.trim().match(/^(\d+(?:\.\d+)?)\s*(kg|g|kilograms?|grams?|千克|公斤|克)$/i) : null;
  const amount = numeric(unitMatch?.[1] ?? value);
  const unit = plain(unitMatch?.[2] ?? declaredUnit).toLowerCase();
  const factor = ["kg", "kilogram", "kilograms", "\u5343\u514B", "\u516C\u65A4"].includes(unit) ? 1 : ["g", "gram", "grams", "\u514B"].includes(unit) ? 1e-3 : null;
  if (amount === null || factor === null) return null;
  const kg = amount * factor;
  return kg > 0 && kg <= 1e5 ? kg : null;
}
function attributeWeight(values) {
  const matches = values.flatMap((attribute) => {
    if (/面料|克重|fabric|\bgsm\b|平方米|平米|㎡|m(?:²|\^?2)|\bgram(?:me)?[\s-]*weight\b|\bgrammage\b|\bbasis[\s-]*weight\b|\bper\s+square\b/i.test(`${attribute.name} ${attribute.value}`)) return [];
    if (!/重量|毛重|净重|\bweight\b/i.test(attribute.name)) return [];
    const unit = attribute.name.match(/[（(]\s*(kg|g|千克|公斤|克)\s*[）)]/i)?.[1];
    const kg = explicitWeight(attribute.value, unit);
    return kg === null ? [] : [{ kg, gross: /毛重|包装|gross|package|shipping/i.test(attribute.name) }];
  });
  return matches.find((match) => match.gross)?.kg ?? matches[0]?.kg ?? null;
}
function packagedWeight(item) {
  const packageInfo = row(item.package_info);
  return explicitWeight(packageInfo?.weight, packageInfo?.weight_unit) ?? explicitWeight(item.weight, item.weight_unit);
}
function skuPropertyMap(value) {
  const result = /* @__PURE__ */ new Map();
  if (!Array.isArray(value)) return result;
  for (const raw of value.slice(0, 100)) {
    const property = row(raw);
    const name = plain(property?.prop_name, 120);
    const values = property?.values;
    if (!name || !Array.isArray(values)) continue;
    for (const entry of values.slice(0, 2e3)) {
      const option = row(entry);
      const label = plain(option?.name, 200);
      if (!label || option?.vid === void 0 || property?.pid === void 0) continue;
      const image = safeImage(option.imageUrl);
      result.set(`${String(property.pid)}:${String(option.vid)}`, { name, value: label, ...image ? { image } : {} });
    }
  }
  return result;
}
function normalizeVariants(item) {
  if (item.skus === void 0 || item.skus === null) return [];
  if (!Array.isArray(item.skus) || item.skus.length > 5e3) return null;
  const propertyMap = skuPropertyMap(item.sku_props);
  const variants = [];
  const ids = /* @__PURE__ */ new Set();
  for (const raw of item.skus) {
    const sku = row(raw);
    const id = identifier(sku?.skuid);
    const price = numeric(sku?.sale_price);
    if (!sku || !id || price === null || ids.has(id)) return null;
    ids.add(id);
    const pairs = typeof sku.props_ids === "string" ? sku.props_ids.split(";").map((key) => propertyMap.get(key)).filter((entry) => entry !== void 0) : [];
    const parsedNames = typeof sku.props_names === "string" ? sku.props_names.split(";").flatMap((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1) return [];
      const name = plain(entry.slice(0, separator), 120);
      const value = plain(entry.slice(separator + 1), 200);
      return name && value ? [{ name, value }] : [];
    }) : [];
    const skuAttributes = pairs.length > 0 ? pairs.map(({ name, value }) => ({ name, value })) : parsedNames;
    const weightKg = packagedWeight(sku);
    const stock = integer(sku.stock, true);
    const image = safeImage(sku.imageUrl) ?? pairs.find((pair) => pair.image)?.image;
    variants.push({ id, attributes: skuAttributes, priceCny: price, ...stock !== null ? { stock } : {}, weightKg, weightSource: weightKg === null ? "missing" : "supplier", ...image ? { image } : {} });
  }
  return variants;
}
function priceTiers(item) {
  const tiers = row(item.tiered_price_info)?.prices ?? row(item.sku_price_range)?.sku_param;
  if (!Array.isArray(tiers)) return [];
  const result = /* @__PURE__ */ new Map();
  for (const raw of tiers.slice(0, 100)) {
    const tier = row(raw);
    const minQuantity = integer(tier?.beginAmount);
    const price = numeric(tier?.price);
    if (minQuantity !== null && price !== null && !result.has(minQuantity)) result.set(minQuantity, price);
  }
  return [...result].map(([minQuantity, priceCny]) => ({ minQuantity, priceCny })).sort((a, b) => a.minQuantity - b.minQuantity);
}
function normalizeTmapiProduct(payload, options = {}) {
  const item = responseData(payload);
  const id = identifier(item?.item_id);
  if (!item || !id || options.sourceId !== void 0 && options.sourceId !== id) return null;
  if (item.currency !== void 0 && item.currency !== "CNY") return null;
  const title = plain(item.title, 1e3);
  const mainImages = images(item.main_imgs);
  const variants = normalizeVariants(item);
  if (!title || !mainImages.length || variants === null) return null;
  const productAttributes = attributes(item.product_props);
  const tiers = priceTiers(item);
  const minimum = integer(row(item.tiered_price_info)?.begin_num) ?? integer(row(item.sku_price_range)?.begin_num) ?? integer(item.moq) ?? tiers[0]?.minQuantity;
  const startingTier = tiers.filter((tier) => tier.minQuantity <= (minimum ?? 1)).at(-1);
  const priceCny = variants.length > 0 ? Math.min(...variants.map((variant) => variant.priceCny)) : startingTier?.priceCny ?? numeric(row(item.price_info)?.price) ?? numeric(item.price);
  if (priceCny === null || priceCny === void 0) return null;
  const delivery = row(item.delivery_info);
  let weightKg = packagedWeight(item) ?? explicitWeight(delivery?.unit_weight, delivery?.weight_unit) ?? attributeWeight(productAttributes);
  if (weightKg === null && variants.length && variants[0].weightKg !== null && variants.every((variant) => variant.weightKg === variants[0].weightKg)) weightKg = variants[0].weightKg;
  const allAttributes = variants.flatMap((variant) => variant.attributes);
  const colors = [...new Set(allAttributes.filter((attribute) => /^(颜色|颜色分类|colou?rs?)$/i.test(attribute.name)).map((attribute) => attribute.value))];
  const sizes = [...new Set(allAttributes.filter((attribute) => /^(尺码|尺寸|sizes?)$/i.test(attribute.name)).map((attribute) => attribute.value))];
  const detailImages = [.../* @__PURE__ */ new Set([...images(item.detail_imgs), ...images(item.detail_images), ...images(item.desc_imgs), ...images(options.detailImages)])];
  return {
    id: `1688-${id}`,
    title,
    sourceTitle: plain(options.sourceTitle, 1e3) || title,
    category: plain(options.category, 80) || "Imported",
    priceCny,
    image: mainImages[0],
    images: mainImages,
    detailImages,
    attributes: productAttributes,
    ...variants.length ? { variants } : {},
    weightKg,
    weightSource: weightKg === null ? "missing" : "supplier",
    colors: colors.length ? colors : ["As listed"],
    sizes: sizes.length ? sizes : ["As listed"],
    description: plain(item.description, 1e4),
    source: "1688",
    sourceProductId: id,
    originUrl: `https://detail.1688.com/offer/${id}.html`,
    isImported: true,
    tag: "Supplier data",
    ...minimum !== void 0 && minimum !== null ? { minQuantity: minimum } : {},
    ...tiers.length ? { priceTiers: tiers } : {},
    ...options.fetchedAt && !Number.isNaN(Date.parse(options.fetchedAt)) ? { fetchedAt: new Date(options.fetchedAt).toISOString() } : {}
  };
}

// src/shipping-weight.ts
var DEFAULT_ESTIMATED_WEIGHT_FLOOR_KG = 1;
function fallbackWeight(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(0.05, Math.min(20, value)) : DEFAULT_ESTIMATED_WEIGHT_FLOOR_KG;
}
function categoryRule(product, fallbackKg) {
  const category = product.category.toLowerCase();
  const title = `${product.title} ${product.sourceTitle ?? ""}`.toLowerCase();
  if (/^(clothing|apparel|服装|服饰)$/.test(category)) return { name: "Clothing", floor: 0.8, textLimit: 5 };
  if (/^(footwear|shoes|鞋|鞋类)$/.test(category)) return { name: "Footwear", floor: 1.2, textLimit: 5 };
  if (/^(bags|luggage|箱包|包袋)$/.test(category)) return { name: "Bags", floor: 0.8, textLimit: 10 };
  if (/^(accessories|jewelry|jewellery|配饰|饰品)$/.test(category)) return { name: "Accessories", floor: 0.3, textLimit: 2 };
  if (/\b(earrings?|necklaces?|bracelets?|pendants?|keychains?|hair\s*clips?|watches)\b|耳环|项链|手链|吊坠|发夹|钥匙扣/.test(title)) return { name: "Accessories", floor: 0.3, textLimit: 2 };
  if (/\b(sneakers?|shoes?|boots?|sandals?|slippers?)\b|运动鞋|皮鞋|拖鞋|凉鞋/.test(title)) return { name: "Footwear", floor: 1.2, textLimit: 5 };
  if (/\b(backpacks?|handbags?|crossbody|tote\s*bags?)\b|双肩包|手提包|斜挎包/.test(title)) return { name: "Bags", floor: 0.8, textLimit: 10 };
  if (/\b(hoodies?|sweatshirts?|t-shirts?|shirts?|jackets?|trousers?|jeans|dresses|coats?)\b|卫衣|夹克|衬衫|连衣裙|外套/.test(title)) return { name: "Clothing", floor: 0.8, textLimit: 5 };
  return { name: "Unknown category", floor: fallbackWeight(fallbackKg), textLimit: 20 };
}
function usableWeight(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e5 && Math.round(value * 1e3) > 0;
}
function recordedWeight(target) {
  if (!usableWeight(target.weightKg) || !["supplier", "operator", "demo", "estimated"].includes(target.weightSource)) return null;
  return {
    weightKg: target.weightKg,
    weightSource: target.weightSource,
    ...target.weightNote !== void 0 ? { weightNote: target.weightNote } : {}
  };
}
var ignoredAttribute = /(?:size|sizing|height|body\s*weight|recommended|suitable|wearer|capacity|volume|stock|inventory|quantity|density|gsm|克每平方米|尺码|尺寸|身高|体重|适合|建议|容量|容积|库存|数量|密度)/i;
var weightOrColorAttribute = /(?:weight|grammage|克重|重量|毛重|净重|包装|colou?r|颜色)/i;
function textWeightHints(text2, textLimit) {
  const hints = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(?:[-–—~至到]\s*(\d+(?:\.\d+)?)\s*)?(kilograms?|kg|公斤|千克|grams?|g|克)(?![a-z])/gi;
  for (const match of text2.matchAll(pattern)) {
    const before = text2.slice(Math.max(0, match.index - 45), match.index);
    const after = text2.slice(match.index + match[0].length, match.index + match[0].length + 45);
    if (/(?:\b(?:body\s*weight|recommended(?:\s*weight)?|wearer|suitable\s*for|fits?\s*(?:people|person|body)?|height|size\s*[:：]?|stock|inventory|capacity)\b|体重|身高|建议|推荐|适合|尺码|库存|容量)[^.;。;；]{0,35}$/i.test(before)) continue;
    if (/\b(?:[2-9]?x{0,3}[sml])\s*[:：-]?\s*$/i.test(before)) continue;
    if (/^\s*(?:\/|per\b|每)\s*(?:square|sq\b|m\b|m[²2]|㎡|cm|ml|l\b|升|平方米|平方)/i.test(after) || /^\s*(?:每平方米|每平米|\/㎡|\/m[²2])/i.test(after)) continue;
    const unit = match[3].toLowerCase();
    const number = Math.max(Number(match[1]), Number(match[2] ?? match[1]));
    const kg = number * (/^(?:kg|kilogram|kilograms|公斤|千克)$/.test(unit) ? 1 : 1e-3);
    if (Number.isFinite(kg) && kg > 0 && kg <= textLimit) hints.push(kg);
  }
  return hints;
}
function productHints(product, rule) {
  const hints = [
    ...textWeightHints(product.title, rule.textLimit),
    ...textWeightHints(product.sourceTitle ?? "", rule.textLimit)
  ];
  const attributes2 = [...product.attributes ?? [], ...(product.variants ?? []).flatMap((variant) => variant.attributes)];
  for (const attribute of attributes2) {
    if (ignoredAttribute.test(attribute.name) || !weightOrColorAttribute.test(attribute.name)) continue;
    const text2 = `${attribute.name}: ${attribute.value}`;
    if (/\bgsm\b|g\s*\/\s*(?:m[²2]|㎡)|克\s*\/\s*(?:平方米|平米)/i.test(text2)) continue;
    hints.push(...textWeightHints(attribute.value, rule.textLimit));
  }
  return hints;
}
function estimateShippingWeight(product, fallbackKg, variant) {
  if (product.detailsLoaded === false) return { weightKg: null, weightSource: "missing", weightNote: "Open product details before estimating shipping." };
  const recorded = recordedWeight(variant ?? product);
  if (recorded) return recorded;
  const rule = categoryRule(product, fallbackKg);
  const hints = productHints(product, rule);
  const known = [product, ...product.variants ?? []].flatMap((entry) => recordedWeight(entry)?.weightKg ?? []);
  const upper = hints.concat(known).reduce((largest, value) => Math.max(largest, value), 0);
  const weightKg = Math.ceil(Math.max(rule.floor, upper) * 1e3) / 1e3;
  return {
    weightKg,
    weightSource: "estimated",
    weightNote: `Estimated conservatively at ${weightKg} kg per item: ${rule.name} fallback ${rule.floor} kg${upper > 0 ? `; upper product-weight hint ${upper} kg` : "; no usable product-weight hint"}. Not a measured shipping weight.`
  };
}
function applyEstimatedWeights(product, fallbackKg, options = {}) {
  const clone = {
    ...product,
    colors: [...product.colors],
    sizes: [...product.sizes],
    ...product.images ? { images: [...product.images] } : {},
    ...product.detailImages ? { detailImages: [...product.detailImages] } : {},
    ...product.attributes ? { attributes: product.attributes.map((attribute) => ({ ...attribute })) } : {},
    ...product.priceTiers ? { priceTiers: product.priceTiers.map((tier) => ({ ...tier })) } : {},
    ...product.variants ? { variants: product.variants.map((variant) => ({ ...variant, attributes: variant.attributes.map((attribute) => ({ ...attribute })) })) } : {}
  };
  if (clone.detailsLoaded === false) {
    clone.weightKg = null;
    clone.weightSource = "missing";
    delete clone.weightNote;
    return clone;
  }
  if (options.refreshEstimated) {
    for (const target of [clone, ...clone.variants ?? []]) {
      if (target.weightSource !== "estimated") continue;
      target.weightKg = null;
      target.weightSource = "missing";
      delete target.weightNote;
    }
  }
  const estimated = estimateShippingWeight(clone, fallbackKg);
  const variants = clone.variants?.map((variant) => ({ ...variant, ...estimateShippingWeight(clone, fallbackKg, variant) }));
  return { ...clone, ...estimated, ...variants ? { variants } : {} };
}

// server/catalog.ts
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text(value, limit = 1e3) {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
function positive(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER ? n : null;
}
function imageUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    for (const name of [...url.searchParams.keys()]) if (/key|secret|token|auth|credential|signature|sign/i.test(name)) url.searchParams.delete(name);
    return url.href;
  } catch {
    return null;
  }
}
function normalizeSearchCard(value, fetchedAt) {
  const item = object(value);
  if (!item) return null;
  const id = typeof item.item_id === "number" && Number.isSafeInteger(item.item_id) ? String(item.item_id) : item.item_id;
  if (typeof id !== "string" || !/^[1-9]\d{0,31}$/.test(id)) return null;
  if (item.currency !== void 0 && item.currency !== "CNY") return null;
  const title = text(item.title);
  const image = imageUrl(item.img);
  const priceInfo = object(item.price_info);
  const price = positive(item.price) ?? positive(priceInfo?.price) ?? positive(priceInfo?.sale_price);
  if (!title || !image || price === null) return null;
  const minQuantity = positive(item.moq) ?? positive(item.quantity_begin);
  return {
    id: `1688-${id}`,
    title,
    sourceTitle: text(item.title_origin) || title,
    category: "Imported",
    priceCny: price,
    image,
    images: [image],
    colors: [],
    sizes: [],
    description: "",
    source: "1688",
    sourceProductId: id,
    originUrl: `https://detail.1688.com/offer/${id}.html`,
    isImported: true,
    weightKg: null,
    weightSource: "missing",
    detailsLoaded: false,
    fetchedAt,
    ...minQuantity !== null && Number.isSafeInteger(minQuantity) ? { minQuantity } : {}
  };
}
function sanitizeProduct(product, key) {
  const secrets = key ? [.../* @__PURE__ */ new Set([key, encodeURIComponent(key), encodeURI(key)])] : [];
  const scrub = (value) => {
    if (typeof value === "string") return secrets.reduce((s, secret) => s.split(secret).join("[redacted]"), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scrub(entry)]));
    return value;
  };
  const clean = scrub(product);
  const cleanUrl = (value) => typeof value === "string" && !value.includes("[redacted]") ? imageUrl(value) : null;
  clean.image = cleanUrl(clean.image) ?? "";
  if (!clean.image) return null;
  clean.images = clean.images?.flatMap((value) => {
    const url = cleanUrl(value);
    return url ? [url] : [];
  });
  clean.detailImages = clean.detailImages?.flatMap((value) => {
    const url = cleanUrl(value);
    return url ? [url] : [];
  });
  clean.originUrl = cleanUrl(clean.originUrl) ?? void 0;
  clean.variants = clean.variants?.map((variant) => ({ ...variant, image: cleanUrl(variant.image) ?? void 0 }));
  return clean;
}

// server/api-server.ts
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["https://cnbuy.pro", "https://www.cnbuy.pro", "https://cnbuy-preview.onrender.com", "http://localhost:5173"]);
function envInt(value, fallback, max) {
  return value !== void 0 && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : fallback;
}
function configFromEnv(env = process.env) {
  return {
    apiKey: env.TMAPI_API_KEY?.trim() ?? "",
    port: envInt(env.PORT, 8787, 65535),
    hourlyBudget: envInt(env.PROVIDER_HOURLY_BUDGET, 60, 1e4),
    dailyBudget: envInt(env.PROVIDER_DAILY_BUDGET, 300, 1e5),
    requestsPerMinute: envInt(env.CLIENT_REQUESTS_PER_MINUTE, 30, 300),
    maxCacheEntries: envInt(env.CATALOG_CACHE_ENTRIES, 200, 1e3),
    timeoutMs: envInt(env.PROVIDER_TIMEOUT_MS, 6e4, 9e4),
    trustProxy: env.TRUST_PROXY === "1"
  };
}
var ApiError = class extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  status;
  code;
  retryAfter;
};
var Cache = class {
  constructor(max, now) {
    this.max = max;
    this.now = now;
  }
  max;
  now;
  entries = /* @__PURE__ */ new Map();
  bytes = 0;
  maxBytes = 16 * 1024 * 1024;
  remove(key) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return void 0;
    if (entry.expires <= this.now()) {
      this.remove(key);
      return void 0;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  put(key, value, ttl) {
    this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes / 4) return;
    this.entries.set(key, { value, expires: this.now() + ttl, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.max || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
  }
};
function createCatalogService(config, transport = fetch, now = Date.now) {
  const searchCache = new Cache(config.maxCacheEntries, now);
  const detailCache = new Cache(config.maxCacheEntries, now);
  const titles = new Cache(config.maxCacheEntries * 20, now);
  const inFlight = /* @__PURE__ */ new Map();
  let hour = -1, day = -1, hourUsed = 0, dayUsed = 0;
  function reserve(count) {
    if (!config.apiKey) throw new ApiError(503, "CATALOG_NOT_CONFIGURED", "The live catalog is not configured yet. Please try again later.");
    const h = Math.floor(now() / 36e5), d = Math.floor(now() / 864e5);
    if (h !== hour) {
      hour = h;
      hourUsed = 0;
    }
    if (d !== day) {
      day = d;
      dayUsed = 0;
    }
    if (hourUsed + count > config.hourlyBudget || dayUsed + count > config.dailyBudget) {
      throw new ApiError(429, "CATALOG_BUDGET_REACHED", "The preview catalog request limit has been reached. Please try again later.", hourUsed + count > config.hourlyBudget ? Math.ceil((36e5 - now() % 36e5) / 1e3) : Math.ceil((864e5 - now() % 864e5) / 1e3));
    }
    hourUsed += count;
    dayUsed += count;
  }
  async function provider(path, parameters) {
    const url = new URL(`https://api.tmapi.top/1688/${path}`);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    let response;
    try {
      response = await transport(url, { method: "GET", headers: { apikey: config.apiKey, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(config.timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      throw new ApiError(timedOut ? 504 : 502, timedOut ? "CATALOG_TIMEOUT" : "CATALOG_UNAVAILABLE", timedOut ? "The supplier took too long to respond. Please try again." : "The supplier catalog is temporarily unavailable. Please try again.");
    }
    let payload;
    try {
      if (Number(response.headers.get("content-length")) > 5e6) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let length = 0;
      const decoder = new TextDecoder();
      let body = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 5e6) {
          await reader.cancel();
          throw new Error();
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      payload = JSON.parse(body + decoder.decode());
    } catch {
      throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned an incomplete response. Please try again.");
    }
    const code = String(object(payload)?.code ?? "");
    if (response.status === 439 || /^439/.test(code)) throw new ApiError(503, "CATALOG_QUOTA_UNAVAILABLE", "Supplier catalog access is temporarily unavailable. Please try again later.", 60);
    if ([401, 403].includes(response.status) || /^(401|403)/.test(code)) throw new ApiError(503, "CATALOG_ACCESS_UNAVAILABLE", "Supplier catalog access is temporarily unavailable. Please try again later.", 60);
    if (!response.ok || code !== "200") throw new ApiError(502, "CATALOG_UNAVAILABLE", "The supplier catalog is temporarily unavailable. Please try again.");
    return payload;
  }
  async function cached(key, cache, ttl, load) {
    const existing = cache.get(key);
    if (existing !== void 0) return { value: structuredClone(existing), cached: true };
    const pending = inFlight.get(key);
    if (pending) return { value: structuredClone(await pending), cached: true };
    if (inFlight.size >= 8) throw new ApiError(503, "CATALOG_BUSY", "The catalog is busy. Please try again shortly.", 5);
    const promise = load().then((value) => {
      cache.put(key, value, ttl);
      return value;
    });
    inFlight.set(key, promise);
    try {
      return { value: structuredClone(await promise), cached: false };
    } finally {
      inFlight.delete(key);
    }
  }
  return {
    async search(query, page) {
      const result = await cached(`search:${page}:${query.toLocaleLowerCase("en")}`, searchCache, 15 * 6e4, async () => {
        reserve(1);
        const english = !/[\p{Script=Han}]/u.test(query);
        const payload = await provider(english ? "global/search/items" : "search/items", { keyword: query, page: String(page), page_size: "20", ...english ? { language: "en" } : {} });
        const data = object(object(payload)?.data);
        if (!Array.isArray(data?.items)) throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned an incomplete search result. Please try again.");
        const fetchedAt = new Date(now()).toISOString();
        const products = [];
        const seen = /* @__PURE__ */ new Set();
        for (const raw of data.items.slice(0, 20)) {
          const normalized = normalizeSearchCard(raw, fetchedAt);
          const product = normalized && sanitizeProduct(normalized, config.apiKey);
          if (product && !seen.has(product.id)) {
            seen.add(product.id);
            products.push(product);
            if (product.sourceTitle) titles.put(product.id, product.sourceTitle, 30 * 6e4);
          }
        }
        if (data.items.length && !products.length) throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned incomplete search products. Please try again.");
        return { products, page, hasMore: page < 10 && data.has_next_page === true, fetchedAt };
      });
      return { ...result.value, cached: result.cached };
    },
    async detail(id) {
      const result = await cached(`detail:${id}`, detailCache, 30 * 6e4, async () => {
        reserve(2);
        const sourceId = id.slice(5);
        const [detail, description] = await Promise.all([
          provider("item_detail", { item_id: sourceId, language: "en" }),
          provider("item_desc", { item_id: sourceId })
        ]);
        const detailImages = tmapiDescriptionImages(description, sourceId);
        if (detailImages === null) throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned incomplete product images. Please try again.");
        const normalized = normalizeTmapiProduct(detail, { sourceId, sourceTitle: titles.get(id), detailImages, fetchedAt: new Date(now()).toISOString() });
        const product = normalized && sanitizeProduct(applyEstimatedWeights({ ...normalized, detailsLoaded: true }, void 0, { refreshEstimated: true }), config.apiKey);
        if (!product) throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned incomplete product details. Please try again.");
        return product;
      });
      return { product: result.value, cached: result.cached };
    }
  };
}
function createApiServer(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const service = createCatalogService(config, dependencies.transport, now);
  const clients = /* @__PURE__ */ new Map();
  function respond(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }
  function clientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    const candidate = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : void 0;
    return config.trustProxy && candidate && isIP(candidate) ? candidate : req.socket.remoteAddress ?? "unknown";
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      respond(res, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "This website is not allowed to access the catalog." } });
      return;
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (req.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Only GET requests are supported.");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        respond(res, 200, { status: "ok", catalogConfigured: Boolean(config.apiKey) });
        return;
      }
      const ip = clientIp(req), minute = Math.floor(now() / 6e4);
      const client = clients.get(ip);
      const state = client?.minute === minute ? client : { minute, count: 0 };
      state.count++;
      clients.delete(ip);
      clients.set(ip, state);
      while (clients.size > 2e3) clients.delete(clients.keys().next().value);
      if (state.count > config.requestsPerMinute) throw new ApiError(429, "TOO_MANY_REQUESTS", "Please wait a moment before searching again.", 60);
      if (url.pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
        const pageValue = url.searchParams.get("page") ?? "1";
        if (!query || [...query].length > 100 || /[\x00-\x1f\x7f<>]/.test(query) || !/^(?:[1-9]|10)$/.test(pageValue)) throw new ApiError(400, "INVALID_SEARCH", "Enter a search term of 1\u2013100 characters and a page from 1 to 10.");
        if (new RegExp("\\p{Script=Bengali}", "u").test(query)) throw new ApiError(422, "SEARCH_LANGUAGE_UNSUPPORTED", "Please search in English or Chinese for now. Bengali search is not available yet.");
        respond(res, 200, await service.search(query, Number(pageValue)));
        return;
      }
      if (url.pathname.startsWith("/api/products/")) {
        const id = url.pathname.slice("/api/products/".length);
        if (!/^1688-[1-9]\d{0,31}$/.test(id)) throw new ApiError(400, "INVALID_PRODUCT_ID", "Please select a valid catalog product.");
        respond(res, 200, await service.detail(id));
        return;
      }
      throw new ApiError(404, "NOT_FOUND", "This API endpoint was not found.");
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "The catalog could not complete this request. Please try again.");
      if (safe.retryAfter) res.setHeader("Retry-After", String(safe.retryAfter));
      respond(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
  server.requestTimeout = 7e4;
  server.headersTimeout = 15e3;
  server.keepAliveTimeout = 5e3;
  return server;
}

// server/index.ts
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configFromEnv();
  const server = createApiServer(config);
  server.listen(config.port, "0.0.0.0", () => console.log(`CNBUY catalog API listening on port ${config.port}.`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    server.close();
    setTimeout(() => process.exit(0), 5e3).unref();
  });
}
