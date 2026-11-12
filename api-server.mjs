// server/index.ts
import { resolve as resolve2 } from "node:path";
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
    const object4 = row(entry);
    if (!object4) continue;
    const pairs = typeof object4.name === "string" && object4.value !== void 0 ? [[object4.name, object4.value]] : Object.entries(object4);
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
  const amount2 = numeric(unitMatch?.[1] ?? value);
  const unit = plain(unitMatch?.[2] ?? declaredUnit).toLowerCase();
  const factor = ["kg", "kilogram", "kilograms", "\u5343\u514B", "\u516C\u65A4"].includes(unit) ? 1 : ["g", "gram", "grams", "\u514B"].includes(unit) ? 1e-3 : null;
  if (amount2 === null || factor === null) return null;
  const kg = amount2 * factor;
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
    const id2 = identifier(sku?.skuid);
    const price = numeric(sku?.sale_price);
    if (!sku || !id2 || price === null || ids.has(id2)) return null;
    ids.add(id2);
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
    variants.push({ id: id2, attributes: skuAttributes, priceCny: price, ...stock !== null ? { stock } : {}, weightKg, weightSource: weightKg === null ? "missing" : "supplier", ...image ? { image } : {} });
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
  const id2 = identifier(item?.item_id);
  if (!item || !id2 || options.sourceId !== void 0 && options.sourceId !== id2) return null;
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
    id: `1688-${id2}`,
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
    sourceProductId: id2,
    originUrl: `https://detail.1688.com/offer/${id2}.html`,
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
function textWeightHints(text3, textLimit) {
  const hints = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(?:[-–—~至到]\s*(\d+(?:\.\d+)?)\s*)?(kilograms?|kg|公斤|千克|grams?|g|克)(?![a-z])/gi;
  for (const match of text3.matchAll(pattern)) {
    const before = text3.slice(Math.max(0, match.index - 45), match.index);
    const after = text3.slice(match.index + match[0].length, match.index + match[0].length + 45);
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
    const text3 = `${attribute.name}: ${attribute.value}`;
    if (/\bgsm\b|g\s*\/\s*(?:m[²2]|㎡)|克\s*\/\s*(?:平方米|平米)/i.test(text3)) continue;
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
  const clone2 = {
    ...product,
    colors: [...product.colors],
    sizes: [...product.sizes],
    ...product.images ? { images: [...product.images] } : {},
    ...product.detailImages ? { detailImages: [...product.detailImages] } : {},
    ...product.attributes ? { attributes: product.attributes.map((attribute) => ({ ...attribute })) } : {},
    ...product.priceTiers ? { priceTiers: product.priceTiers.map((tier) => ({ ...tier })) } : {},
    ...product.variants ? { variants: product.variants.map((variant) => ({ ...variant, attributes: variant.attributes.map((attribute) => ({ ...attribute })) })) } : {}
  };
  if (clone2.detailsLoaded === false) {
    clone2.weightKg = null;
    clone2.weightSource = "missing";
    delete clone2.weightNote;
    return clone2;
  }
  if (options.refreshEstimated) {
    for (const target of [clone2, ...clone2.variants ?? []]) {
      if (target.weightSource !== "estimated") continue;
      target.weightKg = null;
      target.weightSource = "missing";
      delete target.weightNote;
    }
  }
  const estimated = estimateShippingWeight(clone2, fallbackKg);
  const variants = clone2.variants?.map((variant) => ({ ...variant, ...estimateShippingWeight(clone2, fallbackKg, variant) }));
  return { ...clone2, ...estimated, ...variants ? { variants } : {} };
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
  const id2 = typeof item.item_id === "number" && Number.isSafeInteger(item.item_id) ? String(item.item_id) : item.item_id;
  if (typeof id2 !== "string" || !/^[1-9]\d{0,31}$/.test(id2)) return null;
  if (item.currency !== void 0 && item.currency !== "CNY") return null;
  const title = text(item.title);
  const image = imageUrl(item.img);
  const priceInfo = object(item.price_info);
  const price = positive(item.price) ?? positive(priceInfo?.price) ?? positive(priceInfo?.sale_price);
  if (!title || !image || price === null) return null;
  const minQuantity = positive(item.moq) ?? positive(item.quantity_begin);
  return {
    id: `1688-${id2}`,
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
    sourceProductId: id2,
    originUrl: `https://detail.1688.com/offer/${id2}.html`,
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
  invalidate(key) {
    this.remove(key);
  }
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
    } catch (error2) {
      const timedOut = error2 instanceof Error && ["AbortError", "TimeoutError"].includes(error2.name);
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
    async detail(id2, refresh = false) {
      if (refresh) detailCache.invalidate(`detail:${id2}`);
      const result = await cached(`detail:${id2}`, detailCache, 30 * 6e4, async () => {
        reserve(2);
        const sourceId = id2.slice(5);
        const [detail, description] = await Promise.all([
          provider("item_detail", { item_id: sourceId, language: "zh" }),
          provider("item_desc", { item_id: sourceId })
        ]);
        const detailImages = tmapiDescriptionImages(description, sourceId);
        if (detailImages === null) throw new ApiError(502, "CATALOG_INVALID_RESPONSE", "The supplier returned incomplete product images. Please try again.");
        const normalized = normalizeTmapiProduct(detail, { sourceId, sourceTitle: titles.get(id2), detailImages, fetchedAt: new Date(now()).toISOString() });
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
  const service = dependencies.catalogService ?? createCatalogService(config, dependencies.transport, now);
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
    if (dependencies.platformHandler && await dependencies.platformHandler(req, res)) return;
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
        const id2 = url.pathname.slice("/api/products/".length);
        if (!/^1688-[1-9]\d{0,31}$/.test(id2)) throw new ApiError(400, "INVALID_PRODUCT_ID", "Please select a valid catalog product.");
        respond(res, 200, await service.detail(id2));
        return;
      }
      throw new ApiError(404, "NOT_FOUND", "This API endpoint was not found.");
    } catch (error2) {
      const safe = error2 instanceof ApiError ? error2 : new ApiError(500, "INTERNAL_ERROR", "The catalog could not complete this request. Please try again.");
      if (safe.retryAfter) res.setHeader("Retry-After", String(safe.retryAfter));
      respond(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
  server.requestTimeout = 7e4;
  server.headersTimeout = 15e3;
  server.keepAliveTimeout = 5e3;
  return server;
}

// server/platform/http.ts
import { isIP as isIP2 } from "node:net";

// src/domain.ts
var defaultPricingRules = {
  markupPercent: 20,
  exchangeRate: 18,
  depositPercent: 100,
  serviceFeePercent: 0,
  freightPerKg: 50,
  localDeliveryFee: 0,
  commissionPercent: 3,
  specialGoodsPercent: 80,
  estimatedWeightFloorKg: 1
};
var MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
function resolveProductForCart(product, item) {
  if (product.id !== item.productId || product.detailsLoaded === false) return null;
  if (product.variants !== void 0 && !Array.isArray(product.variants)) return null;
  if (product.variants?.length) {
    if (typeof item.skuId !== "string" || !item.skuId) return null;
    const matches = product.variants.filter((variant2) => variant2.id === item.skuId);
    if (matches.length !== 1) return null;
    const variant = matches[0];
    return {
      ...product,
      priceCny: variant.priceCny,
      weightKg: variant.weightKg,
      weightSource: variant.weightSource,
      weightNote: variant.weightNote,
      image: variant.image || product.image
    };
  }
  if (item.skuId !== void 0 || !product.colors.includes(item.color) || !product.sizes.includes(item.size)) return null;
  return { ...product };
}
function getCartLineProduct(product, item, productQuantity = item.quantity) {
  const resolved = resolveProductForCart(product, item);
  if (!resolved) return null;
  const variants = product.variants ?? [];
  const hasUniformSkuPrices = variants.length === 0 || variants.every((variant) => variant.priceCny === variants[0].priceCny);
  if (!hasUniformSkuPrices || !Number.isFinite(productQuantity) || !Array.isArray(product.priceTiers)) return resolved;
  const eligible = product.priceTiers.filter((tier2) => Number.isInteger(tier2.minQuantity) && tier2.minQuantity >= 1 && tier2.minQuantity <= productQuantity && Number.isFinite(tier2.priceCny) && tier2.priceCny >= 0).sort((a, b) => a.minQuantity - b.minQuantity);
  const tier = eligible.at(-1);
  return tier ? { ...resolved, priceCny: tier.priceCny } : resolved;
}

// src/commerce.ts
var currencies = /* @__PURE__ */ new Set(["TWD", "CNY", "USD"]);
var clone = (value) => structuredClone(value);
function decimal(value) {
  if (!Number.isFinite(value)) fail("\u91D1\u984D\u4E0D\u662F\u6709\u6548\u6578\u5B57\u3002");
  const [coefficient, exponent = "0"] = value.toString().toLowerCase().split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const fractionDigits = unsigned.split(".")[1]?.length ?? 0;
  const digits = BigInt(unsigned.replace(".", "")) * (negative ? -1n : 1n);
  const shift = Number(exponent) - fractionDigits;
  return shift >= 0 ? { numerator: digits * 10n ** BigInt(shift), denominator: 1n } : { numerator: digits, denominator: 10n ** BigInt(-shift) };
}
function roundedRatio(numerator, denominator) {
  const sign = numerator < 0 ? -1n : 1n;
  return sign * ((numerator * sign + denominator / 2n) / denominator);
}
function cents(value) {
  const fraction = decimal(value);
  const result = roundedRatio(fraction.numerator * 100n, fraction.denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER))
    fail("\u91D1\u984D\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
  return Number(result);
}
function convertedMoney(value, rate) {
  const a = decimal(value), b = decimal(rate);
  return Number(
    roundedRatio(
      a.numerator * b.numerator * 100n,
      a.denominator * b.denominator
    )
  ) / 100;
}
function tariffTotal(rate, steps) {
  const values = [
    decimal(rate.firstPrice),
    decimal(rate.stepPrice),
    decimal(rate.handlingFee)
  ];
  const denominator = values.reduce(
    (result, value) => result > value.denominator ? result : value.denominator,
    1n
  );
  const numerator = values[0].numerator * (denominator / values[0].denominator) + BigInt(steps) * values[1].numerator * (denominator / values[1].denominator) + values[2].numerator * (denominator / values[2].denominator);
  return Number(roundedRatio(numerator * 100n, denominator)) / 100;
}
var validMoney = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
var validMinorAmount = (value) => validMoney(value) && cents(value) / 100 === value;
var validQuantity = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9999;
function fail(message) {
  throw new Error(message);
}
function requireText(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    fail(`${label}\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002`);
  return value.trim();
}
function date(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail("\u64CD\u4F5C\u6642\u9593\u4E0D\u6B63\u78BA\u3002");
  return new Date(value).toISOString();
}
function currency(value) {
  if (typeof value !== "string" || !currencies.has(value))
    fail("\u4E0D\u652F\u63F4\u7684\u5E63\u5225\u3002");
}
function unitPrice(priceCny, rules) {
  const numerator = BigInt(cents(priceCny)) * BigInt(1e4 + Math.round(rules.markupPercent * 100)) * BigInt(Math.round(rules.exchangeRate * 1e4));
  const minor = (numerator + 50000000n) / 100000000n;
  if (minor > 100000000000n) fail("\u5546\u54C1\u91D1\u984D\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
  return Number(minor) / 100;
}
function quoteGoods(cart, products, rules, selectedCurrency = "TWD", coins) {
  const issues = [];
  const lines = [];
  if (!currencies.has(selectedCurrency)) issues.push("\u4E0D\u652F\u63F4\u7684\u5E63\u5225\u3002");
  const validRules = Number.isFinite(rules.exchangeRate) && rules.exchangeRate >= 1e-4 && rules.exchangeRate <= 1e3 && Number.isFinite(rules.markupPercent) && rules.markupPercent >= 0 && rules.markupPercent <= 1e3 && Number.isFinite(rules.specialGoodsPercent) && rules.specialGoodsPercent >= 0 && rules.specialGoodsPercent <= 100;
  if (!validRules) issues.push("\u8ACB\u78BA\u8A8D\u5831\u50F9\u532F\u7387\u8207\u52A0\u50F9\u8A2D\u5B9A\u3002");
  if (!cart.length) issues.push("\u8CFC\u7269\u8ECA\u5C1A\u7121\u5546\u54C1\u3002");
  if (cart.length > 200) issues.push("\u55AE\u6B21\u8A02\u55AE\u6700\u591A200\u500B\u5546\u54C1\u9078\u9805\u3002");
  const catalog = new Map(products.map((product) => [product.id, product]));
  const quantities = /* @__PURE__ */ new Map();
  const skuQuantities = /* @__PURE__ */ new Map();
  for (const item of cart)
    if (validQuantity(item.quantity)) {
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + item.quantity
      );
      const key = JSON.stringify([
        item.productId,
        item.skuId ?? item.color,
        item.skuId ? "" : item.size
      ]);
      skuQuantities.set(key, (skuQuantities.get(key) ?? 0) + item.quantity);
    }
  for (const item of cart.slice(0, 200)) {
    const product = catalog.get(item.productId);
    if (!product) {
      issues.push("\u8CFC\u7269\u8ECA\u4E2D\u7684\u5546\u54C1\u5DF2\u4E0D\u5B58\u5728\u3002");
      continue;
    }
    if (!validQuantity(item.quantity)) {
      issues.push(`${product.title}\uFF1A\u8ACB\u8F38\u51651\u20139999\u7684\u6574\u6578\u6578\u91CF\u3002`);
      continue;
    }
    const resolved = getCartLineProduct(
      product,
      item,
      quantities.get(product.id)
    );
    if (!resolved) {
      issues.push(`${product.title}\uFF1A\u8ACB\u5148\u8F09\u5165\u5546\u54C1\u8A73\u60C5\u4E26\u9078\u64C7\u6709\u6548\u898F\u683C\u3002`);
      continue;
    }
    if (!Number.isFinite(resolved.priceCny) || resolved.priceCny <= 0 || resolved.priceCny > 1e6) {
      issues.push(`${product.title}\uFF1A\u50F9\u683C\u9700\u8981\u78BA\u8A8D\u3002`);
      continue;
    }
    const minimum = product.minQuantity ?? 1;
    if (!validQuantity(minimum) || (quantities.get(product.id) ?? 0) < minimum)
      issues.push(`${product.title}\uFF1A\u81F3\u5C11\u9700\u8CFC\u8CB7${minimum}\u4EF6\u3002`);
    const variant = product.variants?.find(
      (candidate) => candidate.id === item.skuId
    );
    const key = JSON.stringify([
      item.productId,
      item.skuId ?? item.color,
      item.skuId ? "" : item.size
    ]);
    if (variant?.stock !== void 0 && (!Number.isInteger(variant.stock) || variant.stock < (skuQuantities.get(key) ?? item.quantity)))
      issues.push(`${product.title}\uFF1A\u6240\u9078\u898F\u683C\u5EAB\u5B58\u4E0D\u8DB3\u3002`);
    if (!validRules) continue;
    try {
      const price = unitPrice(resolved.priceCny, rules);
      const total = cents(price) * item.quantity / 100;
      if (!validMoney(total)) {
        issues.push("\u8A02\u55AE\u91D1\u984D\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
        continue;
      }
      lines.push({
        product: clone(product),
        item: clone(item),
        quantity: item.quantity,
        unitPrice: price,
        lineTotal: total
      });
    } catch {
      issues.push("\u5546\u54C1\u91D1\u984D\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
    }
  }
  const merchandise = lines.reduce((sum, line) => sum + cents(line.lineTotal), 0) / 100;
  if (!validMoney(merchandise)) issues.push("\u8A02\u55AE\u91D1\u984D\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
  const requested = coins?.coinUsed ?? 0;
  const coinExchangeRate = coins?.coinExchangeRate ?? 1;
  let coinUsed = 0, coinValue = 0;
  if (!Number.isFinite(coinExchangeRate) || coinExchangeRate <= 0 || coinExchangeRate > 1e3)
    issues.push("CN\u5E63\u63DB\u7B97\u532F\u7387\u4E0D\u6B63\u78BA\u3002");
  if (!validMinorAmount(requested))
    issues.push("CN\u5E63\u6578\u91CF\u9700\u70BA\u975E\u8CA0\u6578\uFF0C\u6700\u591A\u5169\u4F4D\u5C0F\u6578\u3002");
  else if (requested > 0) {
    if (!coins || !validMoney(coins.walletCoins) || requested > coins.walletCoins || !Number.isFinite(coinExchangeRate) || coinExchangeRate <= 0 || coinExchangeRate > 1e3)
      issues.push("CN\u5E63\u9918\u984D\u6216\u63DB\u7B97\u532F\u7387\u4E0D\u6B63\u78BA\u3002");
    else {
      const value = convertedMoney(requested, coinExchangeRate);
      if (value > merchandise || value <= 0)
        issues.push("CN\u5E63\u62B5\u6263\u91D1\u984D\u4E0D\u53EF\u8D85\u904E\u5546\u54C1\u6B3E\u3002");
      else {
        coinUsed = requested;
        coinValue = value;
      }
    }
  }
  return {
    currency: selectedCurrency,
    exchangeRate: rules.exchangeRate,
    markupPercent: rules.markupPercent,
    lines,
    merchandise,
    total: merchandise,
    coinUsed,
    coinExchangeRate,
    coinValue,
    cashNow: (cents(merchandise) - cents(coinValue)) / 100,
    canCheckout: lines.length === cart.length && issues.length === 0,
    issues: [...new Set(issues)]
  };
}
function calculateFreight(measurements, rate, selectedCurrency, at, revision = 1) {
  currency(selectedCurrency);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1e4)
    fail("\u904B\u8CBB\u5831\u50F9\u7248\u672C\u4E0D\u6B63\u78BA\u3002");
  if (rate.currency !== selectedCurrency || !Number.isFinite(rate.exchangeRate) || rate.exchangeRate <= 0 || rate.exchangeRate > 1e3 || !validMoney(rate.priceCnyPerKg))
    fail("\u904B\u8CBB\u5E63\u5225\u6216\u5831\u50F9\u532F\u7387\u4E0D\u6B63\u78BA\uFF0C\u8ACB\u4F7F\u7528\u5305\u88F9\u539F\u59CB\u5E63\u5225\u3002");
  for (const value of [
    measurements.actualWeightKg,
    measurements.lengthCm,
    measurements.widthCm,
    measurements.heightCm
  ])
    if (!Number.isFinite(value) || value <= 0 || value > 1e4)
      fail("\u8ACB\u8F38\u5165\u6709\u6548\u7684\u5305\u88F9\u5BE6\u91CD\u8207\u9577\u5BEC\u9AD8\u3002");
  if (![rate.firstWeightKg, rate.stepWeightKg, rate.volumetricDivisor].every(
    (value) => Number.isFinite(value) && value > 0 && value <= 1e5
  ))
    fail("\u904B\u8CBB\u91CD\u91CF\u6B65\u9032\u8A2D\u5B9A\u4E0D\u6B63\u78BA\u3002");
  if (![rate.firstPrice, rate.stepPrice, rate.handlingFee].every(validMoney))
    fail("\u904B\u8CBB\u91D1\u984D\u8A2D\u5B9A\u4E0D\u6B63\u78BA\u3002");
  requireText(rate.label, "\u8CBB\u7387\u8AAA\u660E");
  const volumetricWeightKg = measurements.lengthCm * measurements.widthCm * measurements.heightCm / rate.volumetricDivisor;
  const billableWeightKg = Math.max(
    measurements.actualWeightKg,
    volumetricWeightKg
  );
  const steps = Math.max(
    0,
    Math.ceil(
      (billableWeightKg - rate.firstWeightKg) / rate.stepWeightKg - 1e-9
    )
  );
  if (!Number.isSafeInteger(steps)) fail("\u904B\u8CBB\u91CD\u91CF\u6B65\u9032\u8A2D\u5B9A\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
  const chargedWeightKg = Math.round((rate.firstWeightKg + steps * rate.stepWeightKg) * 1e6) / 1e6;
  const total = tariffTotal(rate, steps);
  if (!validMoney(total)) fail("\u904B\u8CBB\u8D85\u51FA\u53EF\u8655\u7406\u7BC4\u570D\u3002");
  return {
    revision,
    currency: selectedCurrency,
    exchangeRate: rate.exchangeRate,
    priceCnyPerKg: rate.priceCnyPerKg,
    actualWeightKg: measurements.actualWeightKg,
    volumetricWeightKg,
    billableWeightKg,
    chargedWeightKg,
    total,
    rate: clone(rate),
    quotedAt: date(at)
  };
}

// server/platform/database.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
var migrations = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email_verified_at TEXT,email_notifications INTEGER NOT NULL DEFAULT 1,sms_notifications INTEGER NOT NULL DEFAULT 0,password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf_token TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_challenges (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS addresses (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payment_status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS purchase_lines (line_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,tracking_number TEXT,payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS purchase_lines_tracking ON purchase_lines(tracking_number)`,
  `CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id)`,
  `CREATE TABLE IF NOT EXISTS parcels (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS parcel_allocations (parcel_id TEXT NOT NULL REFERENCES parcels(id),order_id TEXT NOT NULL REFERENCES orders(id),line_id TEXT NOT NULL REFERENCES purchase_lines(line_id),quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(parcel_id,line_id))`,
  `CREATE INDEX IF NOT EXISTS parcels_user ON parcels(user_id)`,
  `CREATE TABLE IF NOT EXISTS payment_attempts (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),reference TEXT NOT NULL UNIQUE,target_type TEXT NOT NULL,target_id TEXT NOT NULL,provider TEXT NOT NULL,provider_payment_id TEXT UNIQUE,amount_minor BIGINT NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS payment_events (provider TEXT NOT NULL,event_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(provider,event_id))`,
  `CREATE TABLE IF NOT EXISTS idempotency (user_id TEXT NOT NULL,key TEXT NOT NULL,route TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,key))`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY,actor_id TEXT,user_id TEXT,action TEXT NOT NULL,target_id TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,read_at TEXT,created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id)`,
  `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS refund_requests (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),order_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,staff_note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS procurement_tasks (id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),line_ids_json TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),request_json TEXT NOT NULL,quote_json TEXT,approval_json TEXT,receipt_json TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS procurement_journal (key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,amount_minor BIGINT NOT NULL,reference TEXT NOT NULL UNIQUE,note TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wallet_reservations (reference TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),amount_minor BIGINT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),amount_minor BIGINT NOT NULL,month TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,proof TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,month))`,
  `CREATE TABLE IF NOT EXISTS affiliate_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id),code TEXT NOT NULL UNIQUE,commission_percent REAL NOT NULL,active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS referrals (customer_id TEXT PRIMARY KEY REFERENCES users(id),promoter_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS affiliate_ledger (id TEXT PRIMARY KEY,promoter_id TEXT NOT NULL REFERENCES users(id),customer_id TEXT NOT NULL REFERENCES users(id),order_id TEXT NOT NULL,amount_minor BIGINT NOT NULL,status TEXT NOT NULL,currency TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(order_id,promoter_id))`
];
async function migrateDatabase(db) {
  await db.transaction(async (tx) => {
    if (tx.dialect === "postgres") await tx.all("SELECT pg_advisory_xact_lock(939001)");
    for (const sql of migrations) await tx.run(sql);
    const columns = tx.dialect === "postgres" ? await tx.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users'") : await tx.all("SELECT name FROM pragma_table_info('users')");
    if (!columns.some((column) => column.name === "phone")) await tx.run("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === "email_notifications")) await tx.run("ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1");
    if (!columns.some((column) => column.name === "sms_notifications")) await tx.run("ALTER TABLE users ADD COLUMN sms_notifications INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "email_verified_at")) await tx.run("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
    await tx.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    await tx.run("INSERT INTO schema_migrations (version,applied_at) VALUES (?,?) ON CONFLICT(version) DO NOTHING", [1, (/* @__PURE__ */ new Date()).toISOString()]);
  });
}
async function createSqliteDatabase(filename) {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 448 });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  let queue = Promise.resolve();
  const serialize = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {
    });
    return next;
  };
  const client = {
    dialect: "sqlite",
    async all(sql, values = []) {
      return sqlite.prepare(sql).all(...values);
    },
    async run(sql, values = []) {
      return Number(sqlite.prepare(sql).run(...values).changes);
    }
  };
  const db = {
    dialect: "sqlite",
    all: (sql, values) => serialize(() => client.all(sql, values)),
    run: (sql, values) => serialize(() => client.run(sql, values)),
    transaction: (work) => serialize(async () => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(client);
        sqlite.exec("COMMIT");
        return result;
      } catch (error2) {
        sqlite.exec("ROLLBACK");
        throw error2;
      }
    }),
    close: () => serialize(async () => {
      sqlite.close();
    })
  };
  await migrateDatabase(db);
  return db;
}
async function createPostgresDatabase(connectionString) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 1e4, idleTimeoutMillis: 3e4 });
  const query = (sql) => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };
  const clientFor = (target) => ({
    dialect: "postgres",
    async all(sql, values = []) {
      return (await target.query(query(sql), values)).rows;
    },
    async run(sql, values = []) {
      return (await target.query(query(sql), values)).rowCount ?? 0;
    }
  });
  const db = {
    ...clientFor(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(clientFor(client));
        await client.query("COMMIT");
        return result;
      } catch (error2) {
        await client.query("ROLLBACK");
        throw error2;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
  await migrateDatabase(db);
  return db;
}
async function databaseFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPostgresDatabase(env.DATABASE_URL);
  if (env.NODE_ENV === "production") throw new Error("DATABASE_URL must be configured in production.");
  return createSqliteDatabase(env.PLATFORM_SQLITE_PATH || ".local-data/platform.sqlite");
}
async function lockUser(tx, userId) {
  await tx.all(`SELECT id FROM users WHERE id=?${tx.dialect === "postgres" ? " FOR UPDATE" : ""}`, [userId]);
}

// server/platform/security.ts
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from "node:crypto";
var PlatformError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var error = (status, code, message) => {
  throw new PlatformError(status, code, message);
};
function text2(value, label, max = 200, optional = false) {
  if (value === void 0 && optional) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) || !optional && !value.trim()) return error(400, "INVALID_INPUT", `${label}\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002`);
  return value.trim();
}
function object2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return error(400, "INVALID_INPUT", "\u8ACB\u63D0\u4F9B\u6709\u6548\u8CC7\u6599\u3002");
  return value;
}
function emailAddress(value) {
  const email = text2(value, "\u96FB\u5B50\u90F5\u4EF6", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "INVALID_EMAIL", "\u8ACB\u8F38\u5165\u6709\u6548\u96FB\u5B50\u90F5\u4EF6\u3002");
  return email;
}
function id() {
  return randomBytes(16).toString("hex");
}
var token = () => randomBytes(32).toString("base64url");
var hash = (value) => createHash("sha256").update(value).digest("hex");
function scrypt(password, salt) {
  return new Promise((resolve3, reject) => nodeScrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve3(key)));
}
async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) return error(400, "WEAK_PASSWORD", "\u5BC6\u78BC\u81F3\u5C1112\u500B\u5B57\u5143\uFF0C\u6700\u95771024\u4F4D\u5143\u7D44\u3002");
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt);
  return `scrypt-v1$${salt}$${key.toString("hex")}`;
}
var dummyHash = `scrypt-v1$00000000000000000000000000000000$${"0".repeat(128)}`;
async function verifyPassword(password, encoded = dummyHash) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt-v1") return false;
  const actual = await scrypt(password, parts[1]);
  const expected = Buffer.from(parts[2], "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
var publicUser = (row2) => ({ id: row2.id, email: row2.email, name: row2.name, phone: row2.phone, emailVerified: Boolean(row2.email_verified_at), notificationPreferences: { email: row2.email_notifications !== 0, sms: row2.sms_notifications === 1 }, role: row2.role, createdAt: row2.created_at });
function platformConfigFromEnv(env = process.env) {
  const production = env.NODE_ENV === "production";
  const publicOrigin = new URL(env.PUBLIC_ORIGIN || env.PUBLIC_APP_URL || "http://localhost:5173").origin;
  const origins = (env.ALLOWED_APP_ORIGINS || env.PLATFORM_ALLOWED_ORIGINS || publicOrigin).split(",").map((value) => new URL(value.trim()).origin);
  const adminOrigin = env.ADMIN_ORIGIN ? new URL(env.ADMIN_ORIGIN).origin : void 0;
  if (adminOrigin) origins.push(adminOrigin);
  if (production && [publicOrigin, ...origins].some((origin) => !origin.startsWith("https://"))) throw new Error("Production platform origins must use HTTPS.");
  return { allowedOrigins: new Set(origins), adminOrigin, publicOrigin, production, sessionHours: 24 * 7, cookieName: production ? "__Host-cnbuy_session" : "cnbuy_session", trustProxy: env.TRUST_PROXY === "1" };
}
function cookieValue(req, name) {
  return req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function sessionCookie(config, value, clear = false) {
  return `${config.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : config.sessionHours * 3600}${config.production ? "; Secure" : ""}`;
}
async function loadSession(db, req, config, now) {
  const raw = cookieValue(req, config.cookieName);
  if (!raw || !/^[A-Za-z\d_-]{40,60}$/.test(raw)) return null;
  const rows = await db.all("SELECT u.*,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.disabled=0", [hash(raw), now]);
  return rows[0] ? { user: publicUser(rows[0]), csrfToken: rows[0].csrf_token, sessionHash: hash(raw) } : null;
}
async function createSession(db, user, config, now) {
  const raw = token(), csrfToken = token();
  await db.run("DELETE FROM sessions WHERE expires_at<=?", [now]);
  await db.run("INSERT INTO sessions (id_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)", [hash(raw), user.id, csrfToken, new Date(Date.parse(now) + config.sessionHours * 36e5).toISOString(), now]);
  return { raw, session: { user, csrfToken, sessionHash: hash(raw) } };
}
function requireRole(session, roles) {
  if (!session) return error(401, "AUTH_REQUIRED", "\u8ACB\u5148\u767B\u5165\u3002");
  if (!roles.includes(session.user.role)) return error(403, "FORBIDDEN", "\u6B64\u5E33\u6236\u6C92\u6709\u64CD\u4F5C\u6B0A\u9650\u3002");
  return session;
}
function protectWrite(req, config, session) {
  if (typeof req.headers.origin !== "string" || !config.allowedOrigins.has(req.headers.origin) || req.headers["x-cnbuy-request"] !== "1") return error(403, "ORIGIN_REJECTED", "\u8ACB\u5F9ECNBUY\u7DB2\u7AD9\u91CD\u65B0\u64CD\u4F5C\u3002");
  if (session && req.headers["x-csrf-token"] !== session.csrfToken) return error(403, "CSRF_REJECTED", "\u767B\u5165\u72C0\u614B\u5DF2\u66F4\u65B0\uFF0C\u8ACB\u91CD\u65B0\u8F09\u5165\u3002");
}

// server/platform/wallet.ts
async function walletFor(db, userId) {
  const ledger = await db.all("SELECT SUM(amount_minor) AS total FROM wallet_ledger WHERE user_id=?", [userId]);
  const held = await db.all("SELECT SUM(amount_minor) AS total FROM wallet_reservations WHERE user_id=?", [userId]);
  const rows = await db.all("SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 200", [userId]);
  const balance = Number(ledger[0].total || 0) / 100, reserved = Number(held[0].total || 0) / 100;
  return { balance, reserved, spendable: Math.max(0, Math.round((balance - reserved) * 100) / 100), currency: "TWD", transactions: rows.map((row2) => ({ id: row2.id, type: row2.kind, amount: Number(row2.amount_minor) / 100, currency: "TWD", createdAt: row2.created_at, reference: row2.reference, note: row2.note })) };
}
async function reserveCoins(tx, userId, reference, coins, kind, now) {
  if (coins === 0) return;
  const existing = (await tx.all("SELECT amount_minor FROM wallet_reservations WHERE reference=? AND user_id=?", [reference, userId]))[0];
  if (existing) {
    if (Number(existing.amount_minor) !== Math.round(coins * 100)) return error(409, "COIN_RESERVATION_CHANGED", "CN\u5E63\u9810\u7559\u984D\u4E0D\u4E00\u81F4\u3002");
    return;
  }
  if (!Number.isFinite(coins) || coins <= 0 || Math.round(coins * 100) / 100 !== coins || (await walletFor(tx, userId)).spendable < coins) return error(409, "INSUFFICIENT_COINS", "\u53EF\u7528CN\u5E63\u4E0D\u8DB3\uFF0C\u672A\u6263\u9664\u9918\u984D\u3002");
  await tx.run("INSERT INTO wallet_reservations (reference,user_id,amount_minor,kind,created_at) VALUES (?,?,?,?,?)", [reference, userId, Math.round(coins * 100), kind, now]);
}
async function postWallet(tx, userId, kind, coins, reference, note, now) {
  const amountMinor = Math.round(coins * 100);
  if (!Number.isSafeInteger(amountMinor)) return error(400, "INVALID_COINS", "CN\u5E63\u91D1\u984D\u4E0D\u6B63\u78BA\u3002");
  await tx.run("INSERT INTO wallet_ledger (id,user_id,kind,amount_minor,reference,note,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING", [id(), userId, kind, amountMinor, reference, note, now]);
}
async function consumeOrderCoins(tx, order, now) {
  if (!order.coinUsed) return;
  const row2 = (await tx.all("SELECT amount_minor FROM wallet_reservations WHERE reference=? AND user_id=?", [`order:${order.id}`, order.userId]))[0];
  if (!row2 || Number(row2.amount_minor) !== Math.round(order.coinUsed * 100)) return error(409, "COIN_RESERVATION_MISSING", "CN\u5E63\u9810\u7559\u8A18\u9304\u4E0D\u5B58\u5728\uFF0C\u4ED8\u6B3E\u5F85\u4EBA\u5DE5\u5C0D\u5E33\u3002");
  await postWallet(tx, order.userId, "order_payment", -order.coinUsed, `order:${order.id}`, `\u5546\u54C1\u6B3E\u62B5\u6263 ${order.id}`, now);
  await tx.run("DELETE FROM wallet_reservations WHERE reference=?", [`order:${order.id}`]);
}
async function releaseDeliveredCommission(tx, orderId, now) {
  const orderRow = (await tx.all("SELECT payload FROM orders WHERE id=?", [orderId]))[0];
  if (!orderRow) return;
  const order = JSON.parse(orderRow.payload);
  if (order.paymentStatus !== "paid") return;
  for (const line of order.lines) {
    const rows = await tx.all("SELECT SUM(a.quantity) AS total FROM parcel_allocations a JOIN parcels p ON p.id=a.parcel_id WHERE a.line_id=? AND p.status='delivered'", [line.id]);
    if (Number(rows[0].total || 0) < line.quantity) return;
  }
  const entries = await tx.all("SELECT id,promoter_id,amount_minor FROM affiliate_ledger WHERE order_id=? AND status='pending'", [order.id]);
  for (const entry of entries) {
    await postWallet(tx, entry.promoter_id, "commission", Number(entry.amount_minor) / 100, `commission:${entry.id}`, `\u8A02\u55AE\u7C3D\u6536\u8FD4\u4F63 ${order.id}`, now);
    await tx.run("UPDATE affiliate_ledger SET status='available' WHERE id=? AND status='pending'", [entry.id]);
  }
}
function withdrawalMonth(now) {
  const date2 = new Date(now), parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date2).map((part) => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day), last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day !== Math.min(30, last)) return error(409, "WITHDRAWAL_DAY", "\u6BCF\u670830\u65E5\u53EF\u7533\u8ACB\u4E00\u6B21\uFF1B2\u6708\u4EE5\u7576\u6708\u6700\u5F8C\u4E00\u5929\u70BA\u6E96\uFF08\u53F0\u5317\u6642\u9593\uFF09\u3002");
  return `${parts.year}-${parts.month}`;
}

// server/platform/repository.ts
var defaultSettings = { markupPercent: 20, specialGoodsPercent: 0, marketRates: { TWD: 4.5, CNY: 1, USD: 0.14 }, freightPerKg: 50, commissionPercent: 5, currency: "TWD" };
async function settings(db) {
  const rows = await db.all("SELECT value FROM settings WHERE key=?", ["platform"]);
  return rows[0] ? JSON.parse(rows[0].value) : structuredClone(defaultSettings);
}
function currency2(value) {
  if (!["TWD", "CNY", "USD"].includes(String(value))) return error(400, "INVALID_CURRENCY", "\u4E0D\u652F\u63F4\u6B64\u5E63\u5225\u3002");
  return value;
}
function quantity(value, max = 9999) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) return error(400, "INVALID_QUANTITY", "\u6578\u91CF\u5FC5\u9808\u662F\u6709\u6548\u6B63\u6574\u6578\u3002");
  return value;
}
function amount(value, max = 1e6) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || Math.round(value * 100) / 100 !== value) return error(400, "INVALID_AMOUNT", "\u91D1\u984D\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
  return value;
}
function address(value) {
  const body = object2(value);
  if (body.country !== "TW") return error(400, "INVALID_COUNTRY", "\u76EE\u524D\u914D\u9001\u5730\u5340\u70BA\u53F0\u7063\u3002");
  const result = { name: text2(body.name, "\u6536\u4EF6\u4EBA", 100), phone: text2(body.phone, "\u96FB\u8A71", 50), city: text2(body.city, "\u7E23\u5E02", 100), district: text2(body.district, "\u5340\u57DF", 100, true), addressLine1: text2(body.addressLine1, "\u5730\u5740", 250), postalCode: text2(body.postalCode, "\u90F5\u905E\u5340\u865F", 6), country: "TW" };
  if (!/^\d{3}(?:\d{2,3})?$/.test(result.postalCode)) return error(400, "INVALID_ADDRESS", "\u90F5\u905E\u5340\u865F\u4E0D\u6B63\u78BA\u3002");
  return result;
}
function packing(value) {
  const body = object2(value);
  if (["removeBoxes", "reinforce", "vacuum"].some((key) => typeof body[key] !== "boolean")) return error(400, "INVALID_PACKING", "\u5305\u88DD\u9078\u9805\u4E0D\u6B63\u78BA\u3002");
  return { removeBoxes: body.removeBoxes, reinforce: body.reinforce, vacuum: body.vacuum, note: text2(body.note, "\u5305\u88DD\u5099\u8A3B", 2e3, true) };
}
function photoList(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 6) return error(400, "INVALID_PHOTOS", "\u6700\u591A\u516D\u5F35\u7167\u7247\u3002");
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 6e5) return error(400, "INVALID_PHOTOS", "\u7167\u7247\u904E\u5927\u3002");
    if (/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(item)) return item;
    try {
      const url = new URL(item);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      return url.href;
    } catch {
      return error(400, "INVALID_PHOTOS", "\u7167\u7247\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
    }
  });
}
async function orderById(db, orderId, owner) {
  const row2 = (await db.all(`SELECT payload FROM orders WHERE id=?${owner ? " AND user_id=?" : ""}`, owner ? [orderId, owner] : [orderId]))[0];
  if (!row2) return error(404, "ORDER_NOT_FOUND", "\u627E\u4E0D\u5230\u6B64\u8A02\u55AE\u3002");
  return JSON.parse(row2.payload);
}
async function parcelById(db, parcelId, owner) {
  const row2 = (await db.all(`SELECT payload FROM parcels WHERE id=?${owner ? " AND user_id=?" : ""}`, owner ? [parcelId, owner] : [parcelId]))[0];
  if (!row2) return error(404, "PARCEL_NOT_FOUND", "\u627E\u4E0D\u5230\u6B64\u5305\u88F9\u3002");
  return JSON.parse(row2.payload);
}
async function ordersFor(db, owner) {
  return (await db.all(`SELECT payload FROM orders${owner ? " WHERE user_id=?" : ""} ORDER BY created_at DESC LIMIT 500`, owner ? [owner] : [])).map((row2) => JSON.parse(row2.payload));
}
async function parcelsFor(db, owner) {
  return (await db.all(`SELECT payload FROM parcels${owner ? " WHERE user_id=?" : ""} ORDER BY created_at DESC LIMIT 500`, owner ? [owner] : [])).map((row2) => JSON.parse(row2.payload));
}
async function saveOrder(db, order) {
  await db.run("UPDATE orders SET payload=?,payment_status=? WHERE id=?", [JSON.stringify(order), order.paymentStatus, order.id]);
  for (const line of order.lines) await db.run("INSERT INTO purchase_lines (line_id,order_id,user_id,status,tracking_number,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(line_id) DO UPDATE SET status=excluded.status,tracking_number=excluded.tracking_number,payload=excluded.payload", [line.id, order.id, order.userId, line.status, line.domesticTrackingNumber || null, JSON.stringify(line)]);
}
async function saveParcel(db, parcel) {
  await db.run("UPDATE parcels SET payload=?,status=? WHERE id=?", [JSON.stringify(parcel), parcel.status, parcel.id]);
}
async function audit(db, actor, owner, action, target, details, at) {
  await db.run("INSERT INTO audit_logs (id,actor_id,user_id,action,target_id,details_json,created_at) VALUES (?,?,?,?,?,?,?)", [id(), actor, owner, action, target, JSON.stringify(details), at]);
}
async function notify(db, owner, type, title, body, at) {
  const notificationId = id();
  await db.run("INSERT INTO notifications (id,user_id,type,title,body,read_at,created_at) VALUES (?,?,?,?,?,?,?)", [notificationId, owner, type, title, body, null, at]);
  const recipient = (await db.all("SELECT phone,email_notifications,sms_notifications FROM users WHERE id=?", [owner]))[0];
  if (recipient.email_notifications !== 0) await db.run("INSERT INTO outbox (id,user_id,kind,payload,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?)", [id(), owner, "email", JSON.stringify({ notificationId, subject: title, text: body }), "pending", 0, at, at]);
  if (recipient.sms_notifications === 1 && /^\+[1-9]\d{7,14}$/.test(recipient.phone)) await db.run("INSERT INTO outbox (id,user_id,kind,payload,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?)", [id(), owner, "sms", JSON.stringify({ notificationId, to: recipient.phone, text: `${title}\uFF1A${body}`.slice(0, 1500) }), "pending", 0, at, at]);
}
async function notificationsFor(db, userId) {
  return (await db.all("SELECT id,type,title,body,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [userId])).map((row2) => ({ id: row2.id, type: row2.type, title: row2.title, body: row2.body, readAt: row2.read_at, createdAt: row2.created_at }));
}
async function affiliateFor(db, userId) {
  const account = (await db.all("SELECT code,commission_percent,active FROM affiliate_accounts WHERE user_id=?", [userId]))[0];
  if (!account) return { active: false, invitationCode: null, commissionPercent: 0, currency: "TWD", availableCoins: 0, pendingCoins: 0, referralCount: 0, referrals: [], earnings: [] };
  const referrals = await db.all("SELECT u.id,u.name,r.created_at FROM referrals r JOIN users u ON u.id=r.customer_id WHERE r.promoter_id=? ORDER BY r.created_at DESC LIMIT 500", [userId]);
  const entries = await db.all("SELECT id,order_id,customer_id,amount_minor,status,created_at FROM affiliate_ledger WHERE promoter_id=? ORDER BY created_at DESC LIMIT 500", [userId]);
  const totals = (await db.all("SELECT SUM(CASE WHEN status='pending' THEN amount_minor ELSE 0 END) AS pending FROM affiliate_ledger WHERE promoter_id=?", [userId]))[0];
  const count = (await db.all("SELECT COUNT(*) AS total FROM referrals WHERE promoter_id=?", [userId]))[0];
  const wallet = await walletFor(db, userId);
  return { active: Boolean(account.active), invitationCode: account.code, commissionPercent: account.commission_percent, currency: "TWD", availableCoins: wallet.spendable, pendingCoins: Number(totals.pending || 0) / 100, referralCount: Number(count.total), withdrawals: await withdrawalsFor(db, userId), referrals: referrals.map((row2) => ({ customerId: `U-${row2.id.slice(-8)}`, name: `${row2.name.slice(0, 1)}***`, joinedAt: row2.created_at })), earnings: entries.map((row2) => ({ id: row2.id, orderId: row2.order_id, customerId: `U-${row2.customer_id.slice(-8)}`, amount: Number(row2.amount_minor) / 100, status: row2.status, createdAt: row2.created_at })) };
}
function version(current, expected) {
  if (expected !== current.version) return error(409, "VERSION_CONFLICT", "\u8CC7\u6599\u5DF2\u66F4\u65B0\uFF0C\u8ACB\u91CD\u65B0\u8F09\u5165\u5F8C\u64CD\u4F5C\u3002");
}
function customerOnly(user) {
  if (user.role !== "customer") return error(403, "CUSTOMER_REQUIRED", "\u8ACB\u4F7F\u7528\u9867\u5BA2\u5E33\u6236\u9032\u884C\u6B64\u64CD\u4F5C\u3002");
}
async function allocatedQuantity(db, lineId) {
  const rows = await db.all("SELECT SUM(a.quantity) AS total FROM parcel_allocations a JOIN parcels p ON p.id=a.parcel_id WHERE a.line_id=? AND p.status<>'canceled'", [lineId]);
  return Number(rows[0]?.total ?? 0);
}
async function withdrawalsFor(db, userId) {
  return (await db.all(`SELECT * FROM withdrawals${userId ? " WHERE user_id=?" : ""} ORDER BY created_at DESC LIMIT 500`, userId ? [userId] : [])).map((row2) => ({ id: row2.id, userId: row2.user_id, amount: Number(row2.amount_minor) / 100, currency: "TWD", month: row2.month, status: row2.status, note: row2.note, ...row2.proof ? { proof: row2.proof } : {}, createdAt: row2.created_at, updatedAt: row2.updated_at }));
}

// server/integrations/common.ts
var IntegrationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "IntegrationError";
  }
  code;
};
function assertReference(value, name = "reference") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new IntegrationError("invalid_request", `Invalid ${name}.`);
}
function assertMinor(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 99999999) throw new IntegrationError("invalid_request", "Invalid amount in minor units.");
}
function object3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function validHttpsUrl(value) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}
function unavailable(provider, reason) {
  return { provider, configured: false, mode: "unavailable", capabilities: [], reason };
}

// server/platform/service.ts
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
var PlatformService = class {
  constructor(options) {
    this.options = options;
    this.db = options.database;
  }
  options;
  db;
  now() {
    return (this.options.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
  }
  capabilities() {
    return { payments: Boolean(this.options.payment?.status.configured && this.options.payment.status.mode === "live"), catalog: Boolean(this.options.catalog), shipping: false, paymentProvider: this.options.payment?.status.configured ? this.options.payment.status.provider : null, affiliateWithdrawals: true, emailVerification: Boolean(this.options.notifications?.email.status.configured), passwordReset: Boolean(this.options.notifications?.email.status.configured), paymentMode: this.options.payment?.status.mode ?? "unavailable", emailNotifications: Boolean(this.options.notifications?.email.status.configured), smsNotifications: Boolean(this.options.notifications?.sms.status.configured) };
  }
  async publicConfig() {
    return { settings: await settings(this.db), capabilities: this.capabilities() };
  }
  async bootstrap(user) {
    return this.db.transaction(async (tx) => {
      const affiliate = await affiliateFor(tx, user.id);
      return { user, addresses: (await tx.all("SELECT id,payload,created_at FROM addresses WHERE user_id=? ORDER BY created_at DESC", [user.id])).map((row2) => ({ id: row2.id, address: JSON.parse(row2.payload), createdAt: row2.created_at })), orders: await ordersFor(tx, user.id), parcels: await parcelsFor(tx, user.id), notifications: await notificationsFor(tx, user.id), refunds: (await tx.all("SELECT id,order_id,reason,status,staff_note,created_at,updated_at FROM refund_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 200", [user.id])).map((row2) => ({ id: row2.id, orderId: row2.order_id, reason: row2.reason, status: row2.status, staffNote: row2.staff_note, createdAt: row2.created_at, updatedAt: row2.updated_at })), affiliate, wallet: await walletFor(tx, user.id), settings: await settings(tx), capabilities: this.capabilities() };
    });
  }
  async staffDashboard(user) {
    this.staff(user, ["admin", "buyer", "warehouse"]);
    const rows = await this.db.all("SELECT id,email,name,phone,role,created_at FROM users WHERE disabled=0 ORDER BY created_at DESC LIMIT 500");
    const adminData = user.role === "admin" ? { audits: await this.db.all("SELECT id,actor_id,user_id,action,target_id,details_json,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 200"), outbox: await this.db.all("SELECT id,user_id,kind,status,attempts,next_attempt_at,created_at FROM outbox ORDER BY created_at DESC LIMIT 200"), refunds: await this.db.all("SELECT * FROM refund_requests ORDER BY created_at DESC LIMIT 200"), withdrawals: await withdrawalsFor(this.db), providers: [this.options.payment?.status, this.options.notifications?.email.status, this.options.notifications?.sms.status].filter((status) => Boolean(status)) } : {};
    return { ...adminData, orders: await ordersFor(this.db), parcels: user.role === "buyer" ? [] : await parcelsFor(this.db), users: rows.filter((row2) => row2.role === "customer" || user.role === "admin").map((row2) => ({ id: row2.id, email: user.role === "buyer" ? "" : row2.email, name: row2.name, phone: user.role === "buyer" ? "" : row2.phone, role: row2.role, createdAt: row2.created_at })), settings: await settings(this.db), capabilities: this.capabilities() };
  }
  staff(user, roles) {
    if (!roles.includes(user.role)) return error(403, "FORBIDDEN", "\u6B64\u5E33\u6236\u6C92\u6709\u64CD\u4F5C\u6B0A\u9650\u3002");
  }
  async mutate(user, key, route, body, work, lockOwner = user.id) {
    if (!/^[A-Za-z\d_-]{16,100}$/.test(key)) return error(400, "IDEMPOTENCY_REQUIRED", "\u8ACB\u63D0\u4F9B\u6709\u6548\u7684\u64CD\u4F5C\u8B58\u5225\u78BC\u3002");
    const requestHash = hash(canonical(body));
    return this.db.transaction(async (tx) => {
      for (const owner of [.../* @__PURE__ */ new Set([user.id, ...Array.isArray(lockOwner) ? lockOwner : [lockOwner]])].sort()) await lockUser(tx, owner);
      const previous = (await tx.all("SELECT route,request_hash,response_json FROM idempotency WHERE user_id=? AND key=?", [user.id, key]))[0];
      if (previous) {
        if (previous.route !== route || previous.request_hash !== requestHash) return error(409, "IDEMPOTENCY_CONFLICT", "\u6B64\u64CD\u4F5C\u8B58\u5225\u78BC\u5DF2\u7528\u65BC\u5176\u4ED6\u5167\u5BB9\u3002");
        return JSON.parse(previous.response_json);
      }
      const result = await work(tx);
      await tx.run("INSERT INTO idempotency (user_id,key,route,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)", [user.id, key, route, requestHash, JSON.stringify(result), this.now()]);
      return result;
    });
  }
  async goodsQuote(input, user) {
    const body = object2(input);
    const currency3 = currency2(body.currency);
    const requestedCoins = amount(body.coinUsed ?? 0, 1e9);
    if (requestedCoins > 0 && !user) return error(401, "AUTH_REQUIRED", "\u8ACB\u5148\u767B\u5165\u3002");
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) return error(400, "INVALID_CART", "\u6BCF\u55AE\u8ACB\u9078\u64C71\u201340\u9805\u5546\u54C1\u898F\u683C\u3002");
    const items = body.items.map((raw) => {
      const item = object2(raw);
      return { productId: text2(item.productId, "\u5546\u54C1\u7DE8\u865F", 200), quantity: quantity(item.quantity), color: text2(item.color, "\u984F\u8272", 1e3, true), size: text2(item.size, "\u898F\u683C", 1e3, true), ...item.skuId ? { skuId: text2(item.skuId, "SKU", 200) } : {} };
    });
    if (!this.options.catalog) return error(503, "CATALOG_NOT_CONFIGURED", "\u5546\u54C1\u8CC7\u6599\u670D\u52D9\u5C1A\u672A\u914D\u7F6E\uFF0C\u672A\u5EFA\u7ACB\u8A02\u55AE\u3002");
    const ids = [...new Set(items.map((item) => item.productId))];
    if (ids.length > 10) return error(400, "CART_LIMIT", "\u6BCF\u6B21\u6700\u591A10\u7A2E\u5546\u54C1\uFF0C\u8ACB\u5206\u6279\u5EFA\u7ACB\u8A02\u55AE\u3002");
    const products = [];
    for (const productId of ids) {
      const product = await this.options.catalog.getProduct(productId);
      if (product.id !== productId || product.detailsLoaded === false) return error(409, "PRODUCT_UNAVAILABLE", "\u5546\u54C1\u8A73\u60C5\u5C1A\u672A\u5B8C\u6574\u8F09\u5165\u3002");
      products.push(product);
    }
    const settings2 = await settings(this.db);
    const rules = { ...defaultPricingRules, markupPercent: settings2.markupPercent, specialGoodsPercent: settings2.specialGoodsPercent, exchangeRate: settings2.marketRates[currency3] };
    const quote = quoteGoods(items, products, rules, currency3, { coinUsed: requestedCoins, coinExchangeRate: settings2.marketRates[currency3] / settings2.marketRates.TWD, walletCoins: user ? (await walletFor(this.db, user.id)).spendable : 0 });
    if (!quote.canCheckout) return error(409, "CART_UNAVAILABLE", quote.issues[0] || "\u5546\u54C1\u66AB\u4E0D\u53EF\u8CFC\u8CB7\u3002");
    if (quote.merchandise <= 0) return error(409, "INVALID_PRICE", "\u5546\u54C1\u50F9\u683C\u5C1A\u5F85\u78BA\u8A8D\u3002");
    return { quote, settings: settings2 };
  }
  async createOrder(user, key, input) {
    customerOnly(user);
    if (!/^[A-Za-z\d_-]{16,100}$/.test(key)) return error(400, "IDEMPOTENCY_REQUIRED", "\u8ACB\u63D0\u4F9B\u6709\u6548\u7684\u64CD\u4F5C\u8B58\u5225\u78BC\u3002");
    const previous = (await this.db.all("SELECT route,request_hash,response_json FROM idempotency WHERE user_id=? AND key=?", [user.id, key]))[0];
    if (previous) {
      if (previous.route !== "/orders" || previous.request_hash !== hash(canonical(input))) return error(409, "IDEMPOTENCY_CONFLICT", "\u6B64\u64CD\u4F5C\u8B58\u5225\u78BC\u5DF2\u7528\u65BC\u5176\u4ED6\u5167\u5BB9\u3002");
      return JSON.parse(previous.response_json);
    }
    const { quote, settings: settings2 } = await this.goodsQuote(input, user);
    return this.mutate(user, key, "/orders", input, async (tx) => {
      const now = this.now(), orderId = `PO-${id()}`;
      const order = { id: orderId, userId: user.id, version: 1, createdAt: now, currency: quote.currency, exchangeRate: quote.exchangeRate, markupPercent: quote.markupPercent, specialGoodsPercent: settings2.specialGoodsPercent, merchandise: quote.merchandise, paidAmount: 0, coinUsed: quote.coinUsed, coinValue: quote.coinValue, coinExchangeRate: quote.coinExchangeRate, cashDue: quote.cashNow, cashPaid: 0, paymentStatus: "pending", lines: quote.lines.map((line, index) => ({ ...line, id: `${orderId}-L${index + 1}`, status: "awaiting_payment" })), events: [{ at: now, type: "order_created", note: "\u8A02\u55AE\u91D1\u984D\u5DF2\u78BA\u8A8D\uFF0C\u7B49\u5F85\u5546\u54C1\u6B3E\u652F\u4ED8\u3002\u570B\u969B\u904B\u8CBB\u5165\u5EAB\u5408\u5305\u5F8C\u53E6\u8A08\u3002" }] };
      if (quote.coinUsed > (await walletFor(tx, user.id)).spendable) return error(409, "INSUFFICIENT_COINS", "CN\u5E63\u9918\u984D\u5DF2\u8B8A\u66F4\uFF0C\u8ACB\u91CD\u65B0\u78BA\u8A8D\u3002");
      const referral = (await tx.all("SELECT r.promoter_id,a.commission_percent FROM referrals r JOIN affiliate_accounts a ON a.user_id=r.promoter_id WHERE r.customer_id=? AND a.active=1", [user.id]))[0];
      if (referral) order.affiliate = { promoterId: referral.promoter_id, commissionPercent: referral.commission_percent, amountTwd: Math.round(order.merchandise / order.exchangeRate * settings2.marketRates.TWD * referral.commission_percent) / 100 };
      await tx.run("INSERT INTO orders (id,user_id,payment_status,payload,created_at) VALUES (?,?,?,?,?)", [order.id, user.id, order.paymentStatus, JSON.stringify(order), now]);
      await saveOrder(tx, order);
      await audit(tx, user.id, user.id, "order_created", order.id, { currency: order.currency, merchandise: order.merchandise }, now);
      return { order };
    });
  }
  async noActivePayment(tx, targetId) {
    if ((await tx.all("SELECT id FROM payment_attempts WHERE target_id=? AND status IN ('creating','pending')", [targetId])).length) return error(409, "PAYMENT_IN_PROGRESS", "\u6B64\u7B46\u4ED8\u6B3E\u6B63\u5728\u8655\u7406\uFF0C\u66AB\u6642\u7121\u6CD5\u53D6\u6D88\u6216\u4FEE\u6539\u5831\u50F9\u3002");
  }
  async cancelOrder(user, key, orderId) {
    return this.mutate(user, key, `/orders/${orderId}/cancel`, {}, async (tx) => {
      const order = await orderById(tx, orderId, user.id);
      if (order.paymentStatus !== "pending") return error(409, "ORDER_NOT_CANCELABLE", "\u53EA\u6709\u672A\u4ED8\u6B3E\u8A02\u55AE\u53EF\u4EE5\u76F4\u63A5\u53D6\u6D88\u3002");
      await this.noActivePayment(tx, orderId);
      order.paymentStatus = "canceled";
      order.version++;
      order.events.push({ at: this.now(), type: "order_canceled", note: "\u672A\u4ED8\u6B3E\u8A02\u55AE\u5DF2\u53D6\u6D88\u3002" });
      await saveOrder(tx, order);
      await audit(tx, user.id, user.id, "order_canceled", orderId, {}, this.now());
      return { order };
    });
  }
  async requestParcel(user, key, input) {
    customerOnly(user);
    const body = object2(input);
    if (!Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > 100 || typeof body.rehearsal !== "boolean") return error(400, "INVALID_PARCEL", "\u8ACB\u9078\u64C7\u6709\u6548\u7684\u5408\u5305\u5546\u54C1\u3002");
    const currency3 = currency2(body.currency), packingOptions = packing(body.packingOptions), addressId = text2(body.addressId, "\u5730\u5740\u7DE8\u865F");
    const allocations = body.allocations.map((raw) => {
      const item = object2(raw);
      return { orderId: text2(item.orderId, "\u8A02\u55AE\u7DE8\u865F"), lineId: text2(item.lineId, "\u5546\u54C1\u884C\u7DE8\u865F"), quantity: quantity(item.quantity) };
    });
    if (new Set(allocations.map((item) => item.lineId)).size !== allocations.length) return error(400, "DUPLICATE_ALLOCATION", "\u540C\u4E00\u5546\u54C1\u4E0D\u80FD\u91CD\u8907\u5408\u5305\u3002");
    return this.mutate(user, key, "/parcels", input, async (tx) => {
      const row2 = (await tx.all("SELECT payload FROM addresses WHERE id=? AND user_id=?", [addressId, user.id]))[0];
      if (!row2) return error(404, "ADDRESS_NOT_FOUND", "\u8ACB\u9078\u64C7\u81EA\u5DF1\u7684\u6709\u6548\u6536\u4EF6\u5730\u5740\u3002");
      for (const allocation of allocations) {
        const order = await orderById(tx, allocation.orderId, user.id);
        const line = order.lines.find((item) => item.id === allocation.lineId);
        if (order.paymentStatus !== "paid" || !line || line.status !== "received" || line.quantity - await allocatedQuantity(tx, line.id) < allocation.quantity) return error(409, "INVENTORY_UNAVAILABLE", "\u5546\u54C1\u5C1A\u672A\u9A57\u6536\u5165\u5EAB\u6216\u53EF\u5408\u5305\u6578\u91CF\u4E0D\u8DB3\u3002");
      }
      const now = this.now(), parcel = { id: `PK-${id()}`, userId: user.id, version: 1, createdAt: now, currency: currency3, allocations, address: address(JSON.parse(row2.payload)), packingOptions, rehearsal: body.rehearsal, status: body.rehearsal ? "rehearsing" : "packing", events: [{ at: now, type: "parcel_requested", note: body.rehearsal ? "\u5DF2\u7533\u8ACB\u5305\u88F9\u9810\u6F14\uFF0C\u7B49\u5F85\u5009\u5EAB\u5BE6\u6E2C\u3002" : "\u5DF2\u7533\u8ACB\u5408\u5305\uFF0C\u7B49\u5F85\u5009\u5EAB\u5BE6\u6E2C\u3002" }] };
      await tx.run("INSERT INTO parcels (id,user_id,status,payload,created_at) VALUES (?,?,?,?,?)", [parcel.id, user.id, parcel.status, JSON.stringify(parcel), now]);
      for (const allocation of allocations) await tx.run("INSERT INTO parcel_allocations (parcel_id,order_id,line_id,quantity) VALUES (?,?,?,?)", [parcel.id, allocation.orderId, allocation.lineId, allocation.quantity]);
      await audit(tx, user.id, user.id, "parcel_requested", parcel.id, { allocations }, now);
      return { parcel };
    });
  }
  async parcelAction(user, key, parcelId, action) {
    return this.mutate(user, key, `/parcels/${parcelId}/${action}`, {}, async (tx) => {
      const parcel = await parcelById(tx, parcelId, user.id), now = this.now();
      if (action === "submit") {
        if (parcel.status !== "paid" || !parcel.freightPayment) return error(409, "FREIGHT_UNPAID", "\u8ACB\u5148\u4ED8\u6E05\u570B\u969B\u904B\u8CBB\u518D\u78BA\u8A8D\u5BC4\u9001\u3002");
        parcel.status = "submitted";
      }
      if (action === "cancel") {
        if (!["packing", "rehearsing", "quoted"].includes(parcel.status)) return error(409, "PARCEL_NOT_CANCELABLE", "\u53EA\u6709\u5C1A\u672A\u652F\u4ED8\u904B\u8CBB\u7684\u5305\u88F9\u53EF\u4EE5\u53D6\u6D88\u3002");
        await this.noActivePayment(tx, parcel.id);
        parcel.status = "canceled";
      }
      if (action === "deliver") {
        if (parcel.status !== "shipped") return error(409, "NOT_SHIPPED", "\u5305\u88F9\u5C1A\u672A\u5BC4\u51FA\u3002");
        parcel.status = "delivered";
      }
      parcel.version++;
      parcel.events.push({ at: now, type: `parcel_${action}`, note: action === "submit" ? "\u4F7F\u7528\u8005\u5DF2\u78BA\u8A8D\u5BC4\u9001\u3002" : action === "cancel" ? "\u5305\u88F9\u5DF2\u53D6\u6D88\uFF0C\u5546\u54C1\u53EF\u91CD\u65B0\u5408\u5305\u3002" : "\u4F7F\u7528\u8005\u78BA\u8A8D\u5DF2\u7C3D\u6536\u3002" });
      await saveParcel(tx, parcel);
      if (action === "deliver") for (const allocation of parcel.allocations) await releaseDeliveredCommission(tx, allocation.orderId, now);
      await audit(tx, user.id, user.id, `parcel_${action}`, parcel.id, {}, now);
      return { parcel };
    });
  }
  async staffCommand(user, key, input) {
    const body = object2(input);
    const lineCommand = ["markPurchased", "receiveLine", "markIssue"].includes(body.type);
    this.staff(user, body.type === "markPurchased" ? ["admin", "buyer"] : ["admin", "warehouse"]);
    const owner = lineCommand ? (await orderById(this.db, text2(body.orderId, "\u8A02\u55AE\u7DE8\u865F"))).userId : (await parcelById(this.db, text2(body.parcelId, "\u5305\u88F9\u7DE8\u865F"))).userId;
    return this.mutate(user, key, "/staff/commands", input, async (tx) => {
      const now = this.now();
      if (body.type === "markPurchased" || body.type === "receiveLine" || body.type === "markIssue") {
        const order = await orderById(tx, body.orderId);
        version(order, body.expectedVersion);
        if (order.paymentStatus !== "paid") return error(409, "GOODS_UNPAID", "\u5546\u54C1\u6B3E\u672A\u7D93\u652F\u4ED8\u78BA\u8A8D\uFF0C\u4E0D\u80FD\u958B\u59CB\u63A1\u8CFC\u6216\u6536\u8CA8\u3002");
        const line = order.lines.find((item) => item.id === body.lineId);
        if (!line) return error(404, "LINE_NOT_FOUND", "\u627E\u4E0D\u5230\u5546\u54C1\u884C\u3002");
        const procurementTasks = await tx.all("SELECT line_ids_json,status,receipt_json FROM procurement_tasks WHERE order_id=?", [order.id]);
        for (const task of procurementTasks) {
          if (!JSON.parse(task.line_ids_json).includes(line.id) || task.status === "canceled") continue;
          if (task.status !== "supplier_paid") return error(409, "PROCUREMENT_TASK_ACTIVE", "\u6B64\u5546\u54C1\u6709\u81EA\u52D5\u63A1\u8CFC\u4EFB\u52D9\uFF0C\u8ACB\u5148\u5B8C\u6210\u5C0D\u5E33\u6216\u53D6\u6D88\u672A\u63D0\u4EA4\u4EFB\u52D9\u5F8C\u518D\u624B\u5DE5\u64CD\u4F5C\u3002");
          if (body.type === "markPurchased") {
            const receipt = task.receipt_json ? JSON.parse(task.receipt_json) : void 0;
            if (!receipt?.supplierOrderIds.includes(String(body.supplierOrderNo).trim())) return error(409, "SUPPLIER_ORDER_MISMATCH", "\u8ACB\u586B\u5BEB\u5DF2\u78BA\u8A8D\u63A1\u8CFC\u7D50\u679C\u4E2D\u7684\u4F9B\u61C9\u5546\u8A02\u55AE\u865F\u3002");
          }
        }
        const reserved = await allocatedQuantity(tx, line.id);
        if (body.type === "markPurchased") {
          if (!["purchasing", "purchased", "issue"].includes(line.status) || reserved) return error(409, "INVALID_TRANSITION", "\u6B64\u5546\u54C1\u4E0D\u80FD\u91CD\u65B0\u6A19\u8A18\u63A1\u8CFC\u3002");
          line.supplierOrderNo = text2(body.supplierOrderNo, "\u4F9B\u61C9\u5546\u8A02\u55AE\u865F");
          const tracking = text2(body.domesticTrackingNumber, "\u570B\u5167\u5FEB\u905E\u865F", 150, true);
          if (tracking) line.domesticTrackingNumber = tracking;
          else delete line.domesticTrackingNumber;
          line.status = "purchased";
        } else if (body.type === "receiveLine") {
          if (!["purchased", "received", "issue"].includes(line.status)) return error(409, "NOT_PURCHASED", "\u8ACB\u5148\u8A18\u9304\u63A1\u8CFC\u7D50\u679C\u3002");
          if (typeof body.weightKg !== "number" || !Number.isFinite(body.weightKg) || body.weightKg <= 0 || body.weightKg > 1e4) return error(400, "INVALID_WEIGHT", "\u8ACB\u8A18\u9304\u6BCF\u4EF6\u5546\u54C1\u7684\u5BE6\u969B\u91CD\u91CF\u3002");
          if (reserved && body.weightKg !== line.weightKg) return error(409, "ALLOCATED_LINE", "\u5DF2\u5206\u914D\u5305\u88F9\u7684\u5546\u54C1\u4E0D\u80FD\u4FEE\u6539\u91CD\u91CF\u3002");
          line.weightKg = body.weightKg;
          line.bin = text2(body.bin, "\u5EAB\u4F4D", 80);
          line.status = "received";
          if (body.domesticTrackingNumber !== void 0) {
            const tracking = text2(body.domesticTrackingNumber, "\u570B\u5167\u5FEB\u905E\u865F", 150, true);
            if (tracking) line.domesticTrackingNumber = tracking;
            else delete line.domesticTrackingNumber;
          }
          if (body.qcNote !== void 0) line.qcNote = text2(body.qcNote, "\u8CEA\u6AA2\u5099\u8A3B", 2e3, true);
          if (body.qcPhotos !== void 0) line.qcPhotos = photoList(body.qcPhotos);
        } else {
          if (reserved) return error(409, "ALLOCATED_LINE", "\u6B64\u5546\u54C1\u5DF2\u5206\u914D\u5305\u88F9\uFF0C\u4E0D\u80FD\u76F4\u63A5\u6A19\u8A18\u7570\u5E38\u3002");
          line.status = "issue";
          line.qcNote = text2(body.qcNote, "\u7570\u5E38\u539F\u56E0", 2e3);
          if (body.qcPhotos !== void 0) line.qcPhotos = photoList(body.qcPhotos);
        }
        order.version++;
        order.events.push({ at: now, type: body.type, note: `${line.id}\uFF1A${line.status}` });
        await saveOrder(tx, order);
        await audit(tx, user.id, owner, body.type, line.id, { orderId: order.id, status: line.status }, now);
        await notify(tx, owner, body.type, "\u8A02\u55AE\u72C0\u614B\u66F4\u65B0", `${order.id} \u5546\u54C1\u72C0\u614B\uFF1A${line.status}`, now);
        return { order };
      }
      const parcel = await parcelById(tx, body.parcelId);
      version(parcel, body.expectedVersion);
      if (body.type === "quoteParcel") {
        if (!["packing", "rehearsing", "quoted"].includes(parcel.status)) return error(409, "INVALID_TRANSITION", "\u5DF2\u4ED8\u904B\u8CBB\u7684\u5305\u88F9\u4E0D\u80FD\u91CD\u65B0\u5831\u50F9\u3002");
        await this.noActivePayment(tx, parcel.id);
        const raw = object2(body.measurements);
        const measurements = Object.fromEntries(["actualWeightKg", "lengthCm", "widthCm", "heightCm"].map((field) => [field, raw[field]]));
        const settings2 = await settings(tx), exchangeRate = settings2.marketRates[parcel.currency], step = 0.1;
        const rate = { label: `\u6BCF${step}kg\uFF0CCNY ${settings2.freightPerKg}/kg`, currency: parcel.currency, exchangeRate, priceCnyPerKg: settings2.freightPerKg, firstWeightKg: step, stepWeightKg: step, firstPrice: Math.round(settings2.freightPerKg * exchangeRate * step * 100) / 100, stepPrice: Math.round(settings2.freightPerKg * exchangeRate * step * 100) / 100, volumetricDivisor: 6e3, handlingFee: amount(body.handlingFee ?? 0, 1e4) };
        try {
          parcel.freightQuote = calculateFreight(measurements, rate, parcel.currency, now, (parcel.freightQuote?.revision ?? 0) + 1);
        } catch {
          return error(400, "INVALID_MEASUREMENTS", "\u8ACB\u586B\u5BEB\u6709\u6548\u7684\u5BE6\u91CD\u8207\u5305\u88F9\u9577\u5BEC\u9AD8\u3002");
        }
        parcel.measurements = measurements;
        parcel.packingNote = text2(body.packingNote, "\u6253\u5305\u5099\u8A3B", 2e3, true);
        parcel.packingPhotos = photoList(body.packingPhotos);
        parcel.status = "quoted";
        if (parcel.rehearsal) parcel.rehearsalCompletedAt = now;
      } else if (body.type === "dispatchParcel") {
        if (parcel.status !== "submitted" || !parcel.freightPayment) return error(409, "SHIPMENT_NOT_SUBMITTED", "\u904B\u8CBB\u4ED8\u6E05\u4E14\u9867\u5BA2\u78BA\u8A8D\u5BC4\u9001\u5F8C\u624D\u80FD\u51FA\u8CA8\u3002");
        parcel.tracking = { carrier: text2(body.carrier, "\u7269\u6D41\u5546", 100), number: text2(body.trackingNumber, "\u570B\u969B\u55AE\u865F", 150), shippedAt: now };
        parcel.status = "shipped";
      } else if (body.type === "deliverParcel") {
        if (parcel.status !== "shipped") return error(409, "NOT_SHIPPED", "\u53EA\u53EF\u78BA\u8A8D\u5DF2\u51FA\u8CA8\u5305\u88F9\u3002");
        parcel.status = "delivered";
      } else return error(400, "INVALID_COMMAND", "\u4E0D\u652F\u63F4\u6B64\u64CD\u4F5C\u3002");
      parcel.version++;
      parcel.events.push({ at: now, type: body.type, note: `\u5305\u88F9\u72C0\u614B\uFF1A${parcel.status}` });
      await saveParcel(tx, parcel);
      if (body.type === "deliverParcel") for (const allocation of parcel.allocations) await releaseDeliveredCommission(tx, allocation.orderId, now);
      await audit(tx, user.id, owner, body.type, parcel.id, { status: parcel.status, quoteRevision: parcel.freightQuote?.revision }, now);
      await notify(tx, owner, body.type, "\u5305\u88F9\u72C0\u614B\u66F4\u65B0", `${parcel.id}\uFF1A${parcel.status}`, now);
      return { parcel };
    }, owner);
  }
  async scan(user, value) {
    this.staff(user, ["admin", "warehouse"]);
    const trackingNumber = text2(value, "\u4F9B\u61C9\u5546\u570B\u5167\u5FEB\u905E\u55AE\u865F", 150);
    const rows = await this.db.all("SELECT order_id,line_id FROM purchase_lines WHERE tracking_number=? OR line_id=? ORDER BY order_id LIMIT 100", [trackingNumber, trackingNumber]);
    const matches = [];
    for (const row2 of rows) {
      const order = await orderById(this.db, row2.order_id);
      const line = order.lines.find((item) => item.id === row2.line_id);
      if (line && order.paymentStatus === "paid") matches.push({ order, line });
    }
    return { matches };
  }
  async updateSettings(user, key, input) {
    this.staff(user, ["admin"]);
    const body = object2(input), rates = object2(body.marketRates);
    const settings2 = { markupPercent: amount(body.markupPercent, 1e3), specialGoodsPercent: amount(body.specialGoodsPercent, 100), marketRates: { TWD: 0, CNY: 1, USD: 0 }, freightPerKg: amount(body.freightPerKg, 1e5), commissionPercent: amount(body.commissionPercent, 100), currency: currency2(body.currency) };
    for (const code of ["TWD", "CNY", "USD"]) {
      if (typeof rates[code] !== "number" || !Number.isFinite(rates[code]) || rates[code] <= 0 || rates[code] > 1e3) return error(400, "INVALID_RATE", "\u532F\u7387\u8A2D\u5B9A\u4E0D\u6B63\u78BA\u3002");
      settings2.marketRates[code] = rates[code];
    }
    if (settings2.marketRates.CNY !== 1) return error(400, "INVALID_RATE", "\u4EBA\u6C11\u5E63\u5C0D\u4EBA\u6C11\u5E63\u532F\u7387\u5FC5\u9808\u662F1\u3002");
    return this.mutate(user, key, "/staff/settings", input, async (tx) => {
      await tx.run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ["platform", JSON.stringify(settings2)]);
      await audit(tx, user.id, user.id, "settings_updated", "platform", settings2, this.now());
      return { settings: settings2 };
    });
  }
  async settleGoods(tx, order, method, now) {
    if (order.paymentStatus !== "pending") return error(409, "NOT_PAYABLE", "\u6B64\u8A02\u55AE\u76EE\u524D\u4E0D\u53EF\u4ED8\u6B3E\u3002");
    await consumeOrderCoins(tx, order, now);
    order.paymentStatus = "paid";
    order.paidAmount = order.merchandise;
    order.cashPaid = order.cashDue;
    order.method = method;
    order.paidAt = now;
    order.version++;
    for (const line of order.lines) line.status = "purchasing";
    order.events.push({ at: now, type: "goods_paid", note: "\u5546\u54C1\u6B3E\u5DF2\u7531\u670D\u52D9\u7AEF\u78BA\u8A8D\uFF0C\u63A1\u8CFC\u4EFB\u52D9\u5DF2\u5EFA\u7ACB\u3002" });
    await saveOrder(tx, order);
    if (order.affiliate) await tx.run("INSERT INTO affiliate_ledger (id,promoter_id,customer_id,order_id,amount_minor,status,currency,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(order_id,promoter_id) DO NOTHING", [id(), order.affiliate.promoterId, order.userId, order.id, Math.round(order.affiliate.amountTwd * 100), "pending", "TWD", now]);
  }
  async payment(user, key, targetType, targetId, input) {
    customerOnly(user);
    const body = object2(input);
    if (targetType === "order") {
      const order = await orderById(this.db, targetId, user.id);
      if (order.cashDue === 0 && order.coinUsed > 0) return this.mutate(user, key, `/orders/${targetId}/payment`, input, async (tx) => {
        const current = await orderById(tx, targetId, user.id);
        await this.noActivePayment(tx, targetId);
        await reserveCoins(tx, user.id, `order:${targetId}`, current.coinUsed, "order", this.now());
        await this.settleGoods(tx, current, "cncoins", this.now());
        await audit(tx, user.id, user.id, "goods_paid_cncoins", targetId, { coinUsed: current.coinUsed }, this.now());
        await notify(tx, user.id, "goods_paid", "CN\u5E63\u4ED8\u6B3E\u5DF2\u78BA\u8A8D", `${targetId} \u5DF2\u652F\u4ED8\u3002`, this.now());
        return { provider: "cncoins", status: "paid", reference: targetId };
      });
    }
    if (!this.options.payment?.status.configured || this.options.payment.status.mode !== "live") return error(503, "PAYMENT_NOT_CONFIGURED", "\u652F\u4ED8\u670D\u52D9\u5C1A\u672A\u914D\u7F6E\uFF1B\u6B64\u8A02\u55AE\u5C1A\u672A\u4ED8\u6B3E\uFF0C\u4E5F\u4E0D\u6703\u958B\u59CB\u63A1\u8CFC\u3002");
    const provider = this.options.payment.status.provider;
    if (body.method !== void 0 && !["stripe", "card", "online"].includes(String(body.method))) return error(400, "PAYMENT_METHOD_UNAVAILABLE", "\u6B64\u652F\u4ED8\u65B9\u5F0F\u5C1A\u672A\u555F\u7528\u3002");
    const reservation = await this.mutate(user, key, `/${targetType}s/${targetId}/payment`, input, async (tx) => {
      const target = targetType === "order" ? await orderById(tx, targetId, user.id) : await parcelById(tx, targetId, user.id);
      let due, quoteRevision;
      if ("paymentStatus" in target) {
        if (target.paymentStatus !== "pending") return error(409, "NOT_PAYABLE", "\u6B64\u8A02\u55AE\u76EE\u524D\u4E0D\u53EF\u4ED8\u6B3E\u3002");
        due = target.cashDue;
        await reserveCoins(tx, user.id, `order:${target.id}`, target.coinUsed, "order", this.now());
      } else {
        if (target.status !== "quoted" || !target.freightQuote) return error(409, "NOT_QUOTED", "\u5305\u88F9\u5C1A\u672A\u5831\u50F9\u3002");
        if (body.expectedQuoteRevision !== target.freightQuote.revision) return error(409, "QUOTE_CHANGED", "\u5831\u50F9\u5DF2\u66F4\u65B0\uFF0C\u8ACB\u91CD\u65B0\u78BA\u8A8D\u3002");
        due = target.freightQuote.total;
        quoteRevision = target.freightQuote.revision;
      }
      await this.noActivePayment(tx, targetId);
      if (due <= 0) return error(409, "INVALID_PAYMENT_AMOUNT", "\u4ED8\u6B3E\u91D1\u984D\u9700\u8981\u78BA\u8A8D\u3002");
      const attemptId = id(), reference = `PAY-${attemptId}`, now = this.now();
      await tx.run("INSERT INTO payment_attempts (id,user_id,reference,target_type,target_id,provider,provider_payment_id,amount_minor,currency,status,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [attemptId, user.id, reference, targetType, targetId, provider, null, Math.round(due * 100), target.currency, "creating", JSON.stringify({ quoteRevision }), now]);
      await audit(tx, user.id, user.id, "payment_initiated", targetId, { reference, amount: due, currency: target.currency }, now);
      return { attemptId };
    });
    const attempt = (await this.db.all("SELECT reference,status,provider_payment_id,amount_minor,currency,payload FROM payment_attempts WHERE id=? AND user_id=?", [reservation.attemptId, user.id]))[0];
    if (!attempt) return error(409, "PAYMENT_MISSING", "\u4ED8\u6B3E\u8CC7\u6599\u4E0D\u5B58\u5728\u3002");
    const existing = JSON.parse(attempt.payload);
    if (existing.checkoutUrl && attempt.status === "pending") return { provider, checkoutUrl: existing.checkoutUrl, status: "pending", reference: attempt.reference };
    if (attempt.status === "paid") return { provider, status: "paid", reference: attempt.reference };
    if (attempt.status === "failed") return error(409, "PAYMENT_FAILED", "\u6B64\u4ED8\u6B3E\u5DF2\u7D50\u675F\uFF0C\u8ACB\u4EE5\u65B0\u7684\u64CD\u4F5C\u91CD\u65B0\u4ED8\u6B3E\u3002");
    let session;
    try {
      session = await this.options.payment.createPayment({ idempotencyKey: reservation.attemptId, reference: attempt.reference, amountMinor: Number(attempt.amount_minor), currency: attempt.currency, successUrl: `${this.options.publicOrigin}/?payment=return`, cancelUrl: `${this.options.publicOrigin}/?payment=canceled`, customerEmail: user.email });
    } catch (reason) {
      if (reason instanceof IntegrationError && ["provider_rejected", "invalid_request"].includes(reason.code)) await this.db.transaction(async (tx) => {
        await lockUser(tx, user.id);
        const changed = await tx.run("UPDATE payment_attempts SET status='failed' WHERE id=? AND status='creating'", [reservation.attemptId]);
        if (changed && targetType === "order") await tx.run("DELETE FROM wallet_reservations WHERE reference=?", [`order:${targetId}`]);
      });
      throw reason;
    }
    await this.db.transaction(async (tx) => {
      await lockUser(tx, user.id);
      const latest = (await tx.all("SELECT status,provider_payment_id FROM payment_attempts WHERE id=?", [reservation.attemptId]))[0];
      if (latest.provider_payment_id && latest.provider_payment_id !== session.providerPaymentId) return error(409, "PAYMENT_ID_CONFLICT", "\u4ED8\u6B3E\u8B58\u5225\u78BC\u4E0D\u4E00\u81F4\u3002");
      await tx.run("UPDATE payment_attempts SET provider_payment_id=?,status=?,payload=? WHERE id=?", [session.providerPaymentId, ["paid", "failed"].includes(latest.status) ? latest.status : "pending", JSON.stringify({ ...existing, checkoutUrl: session.checkoutUrl }), reservation.attemptId]);
    });
    const final = (await this.db.all("SELECT status FROM payment_attempts WHERE id=?", [reservation.attemptId]))[0];
    if (final.status === "failed") return error(409, "PAYMENT_FAILED", "\u4ED8\u6B3E\u5DF2\u5931\u6557\u6216\u904E\u671F\uFF0C\u8ACB\u91CD\u65B0\u5EFA\u7ACB\u4ED8\u6B3E\u3002");
    if (final.status === "paid") return { provider, status: "paid", reference: attempt.reference };
    return { provider, checkoutUrl: session.checkoutUrl, status: "pending", reference: attempt.reference };
  }
  /** Called only after adapter signature verification; never from a customer command. */
  async recordVerifiedPayment(event) {
    if (!this.options.payment?.status.configured || this.options.payment.status.mode !== "live") return error(503, "LIVE_PAYMENT_REQUIRED", "\u6E2C\u8A66\u4ED8\u6B3E\u4E0D\u6703\u89E3\u9396\u6B63\u5F0F\u63A1\u8CFC\u3002");
    const existing = (await this.db.all("SELECT user_id FROM payment_attempts WHERE reference=? AND provider=?", [event.reference, event.provider]))[0];
    if (!existing) return error(409, "UNKNOWN_PAYMENT", "\u4ED8\u6B3E\u53C3\u7167\u4E0D\u5B58\u5728\u3002");
    return this.db.transaction(async (tx) => {
      await lockUser(tx, existing.user_id);
      if ((await tx.all("SELECT event_id FROM payment_events WHERE provider=? AND event_id=?", [event.provider, event.eventId])).length) return { received: true, duplicate: true };
      const attempt = (await tx.all("SELECT * FROM payment_attempts WHERE reference=? AND provider=?", [event.reference, event.provider]))[0];
      if (Number(attempt.amount_minor) !== event.amountMinor || attempt.currency !== event.currency || attempt.provider_payment_id && attempt.provider_payment_id !== event.providerPaymentId) return error(409, "PAYMENT_MISMATCH", "\u652F\u4ED8\u8CC7\u6599\u8207\u8A02\u55AE\u4E0D\u4E00\u81F4\uFF0C\u5C1A\u672A\u5165\u5E33\u3002");
      const now = this.now();
      if (event.status === "paid" && attempt.status !== "paid") {
        if (attempt.target_type === "order") {
          const order = await orderById(tx, attempt.target_id, attempt.user_id);
          if (order.paymentStatus !== "pending" || Math.round(order.cashDue * 100) !== event.amountMinor || order.currency !== event.currency) return error(409, "PAYMENT_TARGET_CHANGED", "\u8A02\u55AE\u72C0\u614B\u8207\u4ED8\u6B3E\u4E0D\u4E00\u81F4\uFF0C\u9700\u4EBA\u5DE5\u5C0D\u5E33\u3002");
          await this.settleGoods(tx, order, event.provider, now);
        } else {
          const parcel = await parcelById(tx, attempt.target_id, attempt.user_id), payload = JSON.parse(attempt.payload);
          if (parcel.status !== "quoted" || !parcel.freightQuote || parcel.freightQuote.revision !== payload.quoteRevision || Math.round(parcel.freightQuote.total * 100) !== event.amountMinor || parcel.currency !== event.currency) return error(409, "PAYMENT_TARGET_CHANGED", "\u904B\u8CBB\u5831\u50F9\u8207\u4ED8\u6B3E\u4E0D\u4E00\u81F4\uFF0C\u9700\u4EBA\u5DE5\u5C0D\u5E33\u3002");
          parcel.freightPayment = { amount: event.amountMinor / 100, currency: event.currency, method: event.provider, paidAt: now, quoteRevision: payload.quoteRevision };
          parcel.status = "paid";
          parcel.version++;
          parcel.events.push({ at: now, type: "freight_paid", note: "\u652F\u4ED8\u670D\u52D9\u5DF2\u9A57\u8B49\u570B\u969B\u904B\u8CBB\uFF0C\u7B49\u5F85\u4F7F\u7528\u8005\u78BA\u8A8D\u5BC4\u9001\u3002" });
          await saveParcel(tx, parcel);
        }
        await notify(tx, attempt.user_id, "payment_paid", "\u4ED8\u6B3E\u5DF2\u78BA\u8A8D", `${attempt.target_id} \u7684\u4ED8\u6B3E\u5DF2\u7531\u652F\u4ED8\u670D\u52D9\u78BA\u8A8D\u3002`, now);
      }
      if (event.status === "failed" && ["creating", "pending"].includes(attempt.status) && attempt.target_type === "order") await tx.run("DELETE FROM wallet_reservations WHERE reference=?", [`order:${attempt.target_id}`]);
      const status = attempt.status === "paid" || event.status === "paid" ? "paid" : "failed";
      await tx.run("UPDATE payment_attempts SET status=?,provider_payment_id=? WHERE id=?", [status, event.providerPaymentId, attempt.id]);
      await tx.run("INSERT INTO payment_events (provider,event_id,created_at) VALUES (?,?,?)", [event.provider, event.eventId, now]);
      await audit(tx, null, attempt.user_id, `payment_${event.status}`, attempt.target_id, { reference: event.reference, provider: event.provider, eventId: event.eventId }, now);
      return { received: true };
    });
  }
  async refundRequest(user, key, orderId, input) {
    const reason = text2(object2(input).reason, "\u9000\u6B3E\u539F\u56E0", 2e3);
    return this.mutate(user, key, `/orders/${orderId}/refund`, input, async (tx) => {
      const order = await orderById(tx, orderId, user.id);
      if (order.paymentStatus !== "paid") return error(409, "NOT_PAID", "\u6B64\u8A02\u55AE\u5C1A\u672A\u4ED8\u6B3E\u3002");
      if ((await tx.all("SELECT id FROM refund_requests WHERE order_id=? AND status IN ('requested','approved_pending_provider')", [orderId])).length) return error(409, "REFUND_EXISTS", "\u5DF2\u6709\u9000\u6B3E\u7533\u8ACB\u6B63\u5728\u8655\u7406\u3002");
      const requestId = id(), now = this.now();
      await tx.run("INSERT INTO refund_requests (id,user_id,order_id,reason,status,staff_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", [requestId, user.id, orderId, reason, "requested", null, now, now]);
      await audit(tx, user.id, user.id, "refund_requested", orderId, { requestId }, now);
      await notify(tx, user.id, "refund_requested", "\u9000\u6B3E\u7533\u8ACB\u5DF2\u6536\u5230", "\u7533\u8ACB\u7B49\u5F85\u4EBA\u5DE5\u5BE9\u6838\uFF1B\u5C1A\u672A\u9000\u6B3E\u3002", now);
      return { refund: { id: requestId, orderId, reason, status: "requested", createdAt: now } };
    });
  }
  async reviewRefund(user, key, requestId, input) {
    this.staff(user, ["admin"]);
    const body = object2(input), note = text2(body.note, "\u5BE9\u6838\u8AAA\u660E", 2e3);
    if (!["approve", "reject"].includes(String(body.decision))) return error(400, "INVALID_DECISION", "\u5BE9\u6838\u7D50\u679C\u4E0D\u6B63\u78BA\u3002");
    const row2 = (await this.db.all("SELECT user_id FROM refund_requests WHERE id=?", [requestId]))[0];
    if (!row2) return error(404, "REFUND_NOT_FOUND", "\u627E\u4E0D\u5230\u9000\u6B3E\u7533\u8ACB\u3002");
    return this.mutate(user, key, `/staff/refunds/${requestId}`, input, async (tx) => {
      const status = body.decision === "approve" ? "approved_pending_provider" : "rejected";
      const changed = await tx.run("UPDATE refund_requests SET status=?,staff_note=?,updated_at=? WHERE id=? AND status='requested'", [status, note, this.now(), requestId]);
      if (!changed) return error(409, "REFUND_ALREADY_REVIEWED", "\u6B64\u7533\u8ACB\u5DF2\u5B8C\u6210\u5BE9\u6838\u3002");
      await audit(tx, user.id, row2.user_id, "refund_reviewed", requestId, { status, note }, this.now());
      await notify(tx, row2.user_id, "refund_reviewed", "\u9000\u6B3E\u7533\u8ACB\u5BE9\u6838\u66F4\u65B0", status === "rejected" ? `\u7533\u8ACB\u672A\u901A\u904E\uFF1A${note}` : "\u7533\u8ACB\u5DF2\u6838\u51C6\uFF0C\u7B49\u5F85\u652F\u4ED8\u6E20\u9053\u5BE6\u969B\u9000\u6B3E\uFF1B\u76EE\u524D\u5C1A\u672A\u9000\u6B3E\u3002", this.now());
      return { id: requestId, status };
    }, row2.user_id);
  }
  async activateAffiliate(user, key, input) {
    this.staff(user, ["admin"]);
    const body = object2(input), userId = text2(body.userId, "\u7528\u6236\u7DE8\u865F"), percent = amount(body.commissionPercent, 100);
    return this.mutate(user, key, "/staff/affiliates", input, async (tx) => {
      if (!(await tx.all("SELECT id FROM users WHERE id=? AND role='customer' AND disabled=0", [userId])).length) return error(404, "USER_NOT_FOUND", "\u8ACB\u9078\u64C7\u6709\u6548\u9867\u5BA2\u5E33\u865F\u3002");
      const old = (await tx.all("SELECT code FROM affiliate_accounts WHERE user_id=?", [userId]))[0];
      const code = old?.code || `CN-${id().slice(0, 10).toUpperCase()}`;
      await tx.run("INSERT INTO affiliate_accounts (user_id,code,commission_percent,active) VALUES (?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET commission_percent=excluded.commission_percent,active=1", [userId, code, percent]);
      await audit(tx, user.id, userId, "affiliate_activated", userId, { code, commissionPercent: percent }, this.now());
      return { affiliate: await affiliateFor(tx, userId) };
    }, userId);
  }
  async requestWithdrawal(user, key, input) {
    const body = object2(input), coins = amount(body.amount, 1e9);
    if (coins <= 0) return error(400, "INVALID_AMOUNT", "\u8ACB\u8F38\u5165\u6B63\u6578\u63D0\u9818\u984D\u3002");
    return this.mutate(user, key, "/affiliate/withdrawals", input, async (tx) => {
      const month = withdrawalMonth(this.now());
      if (!(await tx.all("SELECT user_id FROM affiliate_accounts WHERE user_id=? AND active=1", [user.id])).length) return error(403, "AFFILIATE_REQUIRED", "\u5C1A\u672A\u958B\u901A\u63A8\u5EE3\u8005\u5E33\u865F\u3002");
      if ((await tx.all("SELECT id FROM withdrawals WHERE user_id=? AND month=?", [user.id, month])).length) return error(409, "WITHDRAWAL_ALREADY_REQUESTED", "\u672C\u6708\u5DF2\u7533\u8ACB\u904E\u63D0\u9818\u3002");
      const withdrawalId = id(), now = this.now();
      await reserveCoins(tx, user.id, `withdrawal:${withdrawalId}`, coins, "withdrawal", now);
      await tx.run("INSERT INTO withdrawals (id,user_id,amount_minor,month,status,note,proof,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [withdrawalId, user.id, Math.round(coins * 100), month, "requested", text2(body.note, "\u63D0\u9818\u8AAA\u660E", 1e3, true), null, now, now]);
      await audit(tx, user.id, user.id, "withdrawal_requested", withdrawalId, { amount: coins, month }, now);
      await notify(tx, user.id, "withdrawal_requested", "\u63D0\u9818\u7533\u8ACB\u5DF2\u6536\u5230", "\u9918\u984D\u5DF2\u9810\u7559\uFF0C\u7B49\u5F85\u4EBA\u5DE5\u5BE9\u6838\uFF1B\u5C1A\u672A\u8F49\u5E33\u3002", now);
      return { withdrawal: { id: withdrawalId, userId: user.id, amount: coins, currency: "TWD", month, status: "requested", note: text2(body.note, "\u63D0\u9818\u8AAA\u660E", 1e3, true), createdAt: now, updatedAt: now } };
    });
  }
  async reviewWithdrawal(user, key, withdrawalId, input) {
    this.staff(user, ["admin"]);
    const body = object2(input), note = text2(body.note, "\u5BE9\u6838\u8AAA\u660E", 2e3);
    if (!["approve", "reject", "mark_paid"].includes(String(body.decision))) return error(400, "INVALID_DECISION", "\u4E0D\u652F\u63F4\u6B64\u5BE9\u6838\u64CD\u4F5C\u3002");
    const found = (await this.db.all("SELECT user_id FROM withdrawals WHERE id=?", [withdrawalId]))[0];
    if (!found) return error(404, "WITHDRAWAL_NOT_FOUND", "\u627E\u4E0D\u5230\u63D0\u9818\u7533\u8ACB\u3002");
    return this.mutate(user, key, `/staff/withdrawals/${withdrawalId}`, input, async (tx) => {
      const row2 = (await tx.all("SELECT user_id,status,amount_minor FROM withdrawals WHERE id=?", [withdrawalId]))[0];
      const now = this.now();
      let status, proof = null;
      if (body.decision === "approve") {
        if (row2.status !== "requested") return error(409, "WITHDRAWAL_STATUS", "\u6B64\u7533\u8ACB\u4E0D\u80FD\u518D\u6B21\u6838\u51C6\u3002");
        status = "approved";
      } else if (body.decision === "reject") {
        if (!["requested", "approved"].includes(row2.status)) return error(409, "WITHDRAWAL_STATUS", "\u6B64\u7533\u8ACB\u4E0D\u80FD\u62D2\u7D55\u3002");
        status = "rejected";
        await tx.run("DELETE FROM wallet_reservations WHERE reference=?", [`withdrawal:${withdrawalId}`]);
      } else {
        if (row2.status !== "approved") return error(409, "WITHDRAWAL_STATUS", "\u8ACB\u5148\u5BE9\u6838\u901A\u904E\uFF0C\u518D\u8A18\u9304\u5BE6\u969B\u7DDA\u4E0B\u4ED8\u6B3E\u3002");
        proof = text2(body.proof, "\u5BE6\u969B\u6253\u6B3E\u6191\u8B49\u6216\u9280\u884C\u53C3\u8003\u865F", 2e3);
        status = "paid";
        const held = (await tx.all("SELECT amount_minor FROM wallet_reservations WHERE reference=?", [`withdrawal:${withdrawalId}`]))[0];
        if (!held || Number(held.amount_minor) !== Number(row2.amount_minor) || (await walletFor(tx, row2.user_id)).balance < Number(row2.amount_minor) / 100) return error(409, "WITHDRAWAL_BALANCE_CHANGED", "\u63D0\u9818\u9918\u984D\u6216\u9810\u7559\u984D\u5DF2\u8B8A\u66F4\uFF0C\u9700\u4EBA\u5DE5\u6838\u5C0D\u3002");
        await postWallet(tx, row2.user_id, "withdrawal", -Number(row2.amount_minor) / 100, `withdrawal:${withdrawalId}`, `\u7BA1\u7406\u54E1\u8A18\u9304\u7DDA\u4E0B\u6253\u6B3E\uFF1A${proof}`, now);
        await tx.run("DELETE FROM wallet_reservations WHERE reference=?", [`withdrawal:${withdrawalId}`]);
      }
      await tx.run("UPDATE withdrawals SET status=?,note=?,proof=?,updated_at=? WHERE id=?", [status, note, proof, now, withdrawalId]);
      await audit(tx, user.id, row2.user_id, "withdrawal_reviewed", withdrawalId, { status, proof, note, manualPayoutRecord: status === "paid" }, now);
      await notify(tx, row2.user_id, "withdrawal_reviewed", "\u63D0\u9818\u7533\u8ACB\u66F4\u65B0", status === "paid" ? "\u7BA1\u7406\u54E1\u5DF2\u8A18\u9304\u5BE6\u969B\u7DDA\u4E0B\u6253\u6B3E\u53CA\u6191\u8B49\uFF1B\u5E73\u53F0\u672A\u81EA\u52D5\u8F49\u5E33\u3002" : `\u63D0\u9818\u7533\u8ACB\u72C0\u614B\uFF1A${status}`, now);
      return { id: withdrawalId, status };
    }, found.user_id);
  }
  async recordManualRefund(user, key, requestId, input) {
    this.staff(user, ["admin"]);
    const body = object2(input), proof = text2(body.proof, "\u9000\u6B3E\u6191\u8B49", 2e3), providerReference = text2(body.providerReference, "\u9000\u6B3E\u4EA4\u6613\u53C3\u8003\u865F", 200);
    const found = (await this.db.all("SELECT user_id,order_id FROM refund_requests WHERE id=?", [requestId]))[0];
    if (!found) return error(404, "REFUND_NOT_FOUND", "\u627E\u4E0D\u5230\u9000\u6B3E\u7533\u8ACB\u3002");
    const commissionOwners = await this.db.all("SELECT promoter_id FROM affiliate_ledger WHERE order_id=?", [found.order_id]);
    return this.mutate(user, key, `/staff/refunds/${requestId}/record`, input, async (tx) => {
      const request = (await tx.all("SELECT user_id,order_id,status FROM refund_requests WHERE id=?", [requestId]))[0];
      if (request.status !== "approved_pending_provider") return error(409, "REFUND_STATUS", "\u8ACB\u5148\u6838\u51C6\u9000\u6B3E\u7533\u8ACB\u3002");
      const order = await orderById(tx, request.order_id), now = this.now();
      if ((await tx.all("SELECT id FROM procurement_tasks WHERE order_id=? AND status IN ('quoting','submitting','unknown','awaiting_supplier_payment')", [order.id])).length) return error(409, "PROCUREMENT_RECONCILIATION_REQUIRED", "\u63A1\u8CFC\u7D50\u679C\u4ECD\u5F85\u78BA\u8A8D\uFF0C\u8ACB\u5148\u5B8C\u6210\u4F9B\u61C9\u5546\u5C0D\u5E33\u518D\u8A18\u9304\u9000\u6B3E\u3002");
      if (order.paymentStatus !== "paid") return error(409, "REFUND_STATUS", "\u8A02\u55AE\u4E0D\u662F\u5DF2\u4ED8\u6B3E\u72C0\u614B\u3002");
      if ((await tx.all("SELECT p.id FROM parcels p JOIN parcel_allocations a ON a.parcel_id=p.id WHERE a.order_id=? AND p.status NOT IN ('canceled','delivered')", [order.id])).length) return error(409, "REFUND_FULFILLMENT_ACTIVE", "\u4ECD\u6709\u8655\u7406\u4E2D\u5305\u88F9\uFF0C\u8ACB\u5148\u8655\u7406\u5305\u88F9\u53CA\u5BE6\u969B\u7269\u6D41\u5F8C\u518D\u8A18\u9304\u5168\u984D\u9000\u6B3E\u3002");
      if (order.coinUsed) await postWallet(tx, order.userId, "refund", order.coinUsed, `refund-coins:${order.id}`, `\u9000\u56DE\u8A02\u55AECN\u5E63 ${order.id}`, now);
      const commissions = await tx.all("SELECT id,promoter_id,amount_minor,status FROM affiliate_ledger WHERE order_id=?", [order.id]);
      for (const commission of commissions) {
        if (commission.status === "available") await postWallet(tx, commission.promoter_id, "commission_reversal", -Number(commission.amount_minor) / 100, `commission-reversal:${commission.id}`, `\u9000\u6B3E\u4F63\u91D1\u6C96\u92B7 ${order.id}`, now);
        await tx.run("UPDATE affiliate_ledger SET status='reversed' WHERE id=?", [commission.id]);
      }
      order.paymentStatus = "refunded";
      order.version++;
      order.refund = { amount: order.merchandise, currency: order.currency, recordedAt: now, providerReference };
      order.events.push({ at: now, type: "refund_recorded_manual", note: "\u7BA1\u7406\u54E1\u5DF2\u6838\u5C0D\u4E26\u8A18\u9304\u5168\u984D\u9000\u6B3E\u6191\u8B49\uFF1B\u539F\u4ED8\u6B3E\u91D1\u984D\u4FDD\u7559\u3002" });
      await saveOrder(tx, order);
      await tx.run("UPDATE refund_requests SET status='refunded',staff_note=?,updated_at=? WHERE id=?", [proof, now, requestId]);
      await audit(tx, user.id, order.userId, "refund_recorded_manual", order.id, { requestId, proof, providerReference, coinReturned: order.coinUsed, cashAmount: order.cashPaid, currency: order.currency }, now);
      await notify(tx, order.userId, "refund_recorded", "\u9000\u6B3E\u8A18\u9304\u66F4\u65B0", "\u7BA1\u7406\u54E1\u5DF2\u8A18\u9304\u5BE6\u969B\u9000\u6B3E\uFF0CCN\u5E63\u62B5\u6263\u5DF2\u9000\u56DE\uFF1B\u8A73\u60C5\u53EF\u67E5\u770B\u8A02\u55AE\u3002", now);
      return { order };
    }, [found.user_id, ...commissionOwners.map((row2) => row2.promoter_id)]);
  }
};

// server/platform/http.ts
async function readBody(req, raw = false) {
  const maximum = raw ? 1e6 : 4e6;
  if (Number(req.headers["content-length"]) > maximum) return error(413, "BODY_TOO_LARGE", "\u8ACB\u6C42\u8CC7\u6599\u904E\u5927\u3002");
  if (!raw && !String(req.headers["content-type"]).toLowerCase().startsWith("application/json")) return error(415, "JSON_REQUIRED", "\u8ACB\u4F7F\u7528JSON\u8CC7\u6599\u683C\u5F0F\u3002");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) return error(413, "BODY_TOO_LARGE", "\u8ACB\u6C42\u8CC7\u6599\u904E\u5927\u3002");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function jsonBody(bytes) {
  try {
    return object2(JSON.parse(bytes.toString("utf8") || "{}"));
  } catch (reason) {
    if (reason instanceof PlatformError) throw reason;
    return error(400, "INVALID_JSON", "JSON\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
  }
}
function createPlatformHandler(options) {
  const config = options.config ?? platformConfigFromEnv(), service = new PlatformService(options), db = options.database;
  const rates = /* @__PURE__ */ new Map();
  function rateLimit(req, path) {
    const forwarded = config.trustProxy && typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",").at(-1)?.trim() : void 0;
    const clientIp = forwarded && isIP2(forwarded) ? forwarded : req.socket.remoteAddress || "unknown";
    const key = `${clientIp}:${path.startsWith("/auth") ? "auth" : "api"}`, now = Date.now(), maximum = path.startsWith("/auth") ? 25 : 180;
    let row2 = rates.get(key);
    if (!row2 || row2.reset < now) {
      row2 = { count: 0, reset: now + 6e4 };
      rates.set(key, row2);
    }
    if (++row2.count > maximum) return error(429, "RATE_LIMITED", "\u64CD\u4F5C\u592A\u983B\u7E41\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002");
    if (rates.size > 5e3) {
      for (const [key2, value] of rates) if (value.reset < now) rates.delete(key2);
    }
    if (rates.size > 1e4) rates.delete(rates.keys().next().value);
  }
  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://platform.local");
    } catch {
      return false;
    }
    if (!url.pathname.startsWith("/api/platform/")) return false;
    const path = url.pathname.slice("/api/platform".length), method = req.method || "GET";
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    try {
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.has(origin)) return error(403, "ORIGIN_REJECTED", "\u6B64\u7DB2\u7AD9\u4F86\u6E90\u672A\u7372\u5141\u8A31\u3002");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-CNBUY-Request,X-CSRF-Token,Idempotency-Key");
        res.statusCode = 204;
        res.end();
        return true;
      }
      rateLimit(req, path);
      if (path === "/webhooks/stripe" && method === "POST") {
        if (!options.payment?.status.configured) return error(503, "PAYMENT_NOT_CONFIGURED", "\u652F\u4ED8\u670D\u52D9\u5C1A\u672A\u914D\u7F6E\u3002");
        const event = options.payment.verifyWebhook(await readBody(req, true), String(req.headers["stripe-signature"] || ""));
        send(200, event ? await service.recordVerifiedPayment(event) : { received: true, ignored: true });
        return true;
      }
      const session = await loadSession(db, req, config, service.now());
      if (path === "/public-config" && method === "GET") {
        send(200, await service.publicConfig());
        return true;
      }
      if (path === "/session" && method === "GET") {
        send(200, session ? { user: session.user, csrfToken: session.csrfToken } : { user: null, csrfToken: null });
        return true;
      }
      const writing = ["POST", "PATCH", "DELETE"].includes(method);
      if (writing) protectWrite(req, config, path.startsWith("/auth/") && ["/auth/register", "/auth/login", "/auth/forgot-password", "/auth/reset-password", "/auth/verify-email"].includes(path) ? null : session);
      const body = writing ? jsonBody(await readBody(req)) : {};
      if (path === "/auth/register" && method === "POST") {
        const email = emailAddress(body.email), name = text2(body.name, "\u59D3\u540D", 100), passwordHash = await hashPassword(body.password), now = service.now();
        const created = await db.transaction(async (tx) => {
          if ((await tx.all("SELECT id FROM users WHERE email=?", [email])).length) return error(409, "EMAIL_EXISTS", "\u6B64\u96FB\u5B50\u90F5\u4EF6\u5DF2\u8A3B\u518A\uFF0C\u8ACB\u767B\u5165\u3002");
          const user2 = { id: id(), email, name, phone: "", role: "customer", createdAt: now };
          const invitation = text2(body.invitationCode, "\u9080\u8ACB\u78BC", 80, true).toUpperCase();
          const promoter = invitation ? (await tx.all("SELECT user_id FROM affiliate_accounts WHERE code=? AND active=1", [invitation]))[0] : void 0;
          if (invitation && !promoter) return error(400, "INVITATION_INVALID", "\u9080\u8ACB\u78BC\u4E0D\u5B58\u5728\u6216\u5DF2\u505C\u7528\u3002");
          await tx.run("INSERT INTO users (id,email,name,phone,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)", [user2.id, email, name, "", passwordHash, "customer", now]);
          if (promoter) await tx.run("INSERT INTO referrals (customer_id,promoter_id,created_at) VALUES (?,?,?)", [user2.id, promoter.user_id, now]);
          await audit(tx, user2.id, user2.id, "registered", user2.id, { referralBound: Boolean(promoter) }, now);
          return { user: user2, ...await createSession(tx, user2, config, now) };
        });
        res.setHeader("Set-Cookie", sessionCookie(config, created.raw));
        send(201, { user: created.user, csrfToken: created.session.csrfToken });
        return true;
      }
      if (path === "/auth/login" && method === "POST") {
        const email = emailAddress(body.email), row2 = (await db.all("SELECT * FROM users WHERE email=?", [email]))[0];
        if (!await verifyPassword(body.password, row2?.password_hash) || !row2 || row2.disabled) return error(401, "LOGIN_FAILED", "\u96FB\u5B50\u90F5\u4EF6\u6216\u5BC6\u78BC\u4E0D\u6B63\u78BA\u3002");
        const created = await db.transaction(async (tx) => {
          const created2 = await createSession(tx, publicUser(row2), config, service.now());
          await audit(tx, row2.id, row2.id, "login", row2.id, {}, service.now());
          return created2;
        });
        res.setHeader("Set-Cookie", sessionCookie(config, created.raw));
        send(200, { user: created.session.user, csrfToken: created.session.csrfToken });
        return true;
      }
      if (["/auth/forgot-password", "/auth/request-verification"].includes(path) && method === "POST") {
        if (!options.notifications?.email.status.configured) return error(503, "EMAIL_NOT_CONFIGURED", "\u90F5\u4EF6\u670D\u52D9\u5C1A\u672A\u914D\u7F6E\uFF0C\u672A\u767C\u9001\u4EFB\u4F55\u90F5\u4EF6\u3002");
        const user2 = path === "/auth/request-verification" ? requireRole(session, ["customer", "admin", "buyer", "warehouse"]).user : void 0;
        const email = user2?.email ?? emailAddress(body.email);
        const row2 = (await db.all("SELECT * FROM users WHERE email=? AND disabled=0", [email]))[0];
        if (row2) await db.transaction(async (tx) => {
          const now = service.now(), kind = user2 ? "verify_email" : "reset_password", rawToken = token();
          await tx.run("UPDATE auth_challenges SET used_at=? WHERE user_id=? AND kind=? AND used_at IS NULL", [now, row2.id, kind]);
          await tx.run("INSERT INTO auth_challenges (token_hash,user_id,kind,expires_at,used_at,created_at) VALUES (?,?,?,?,?,?)", [hash(rawToken), row2.id, kind, new Date(Date.parse(now) + 30 * 6e4).toISOString(), null, now]);
          const link = `${config.publicOrigin}/?${kind === "verify_email" ? "verifyEmail" : "resetPassword"}=${encodeURIComponent(rawToken)}`;
          await tx.run("INSERT INTO outbox (id,user_id,kind,payload,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?)", [id(), row2.id, "email", JSON.stringify({ to: row2.email, subject: kind === "verify_email" ? "CNBUY \u96FB\u5B50\u90F5\u4EF6\u9A57\u8B49" : "CNBUY \u5BC6\u78BC\u91CD\u8A2D", text: `\u8ACB\u572830\u5206\u9418\u5167\u958B\u555F\u4EE5\u4E0B\u9023\u7D50\uFF1A${link}
\u82E5\u4E0D\u662F\u672C\u4EBA\u64CD\u4F5C\uFF0C\u8ACB\u5FFD\u7565\u6B64\u90F5\u4EF6\u3002` }), "pending", 0, now, now]);
          await audit(tx, row2.id, row2.id, `${kind}_requested`, row2.id, {}, now);
        });
        send(202, { accepted: true, message: "\u82E5\u5E33\u865F\u7B26\u5408\u689D\u4EF6\uFF0C\u90F5\u4EF6\u5DF2\u6392\u5165\u5BC4\u9001\u4F47\u5217\uFF1B\u8ACB\u7A0D\u5F8C\u67E5\u770B\u6536\u4EF6\u5323\u3002" });
        return true;
      }
      if (["/auth/reset-password", "/auth/verify-email"].includes(path) && method === "POST") {
        const rawToken = text2(body.token, "\u9A57\u8B49\u78BC", 100), kind = path === "/auth/reset-password" ? "reset_password" : "verify_email";
        const passwordHash = kind === "reset_password" ? await hashPassword(body.password) : void 0;
        await db.transaction(async (tx) => {
          const now = service.now(), row2 = (await tx.all("SELECT user_id FROM auth_challenges WHERE token_hash=? AND kind=? AND used_at IS NULL AND expires_at>?", [hash(rawToken), kind, now]))[0];
          if (!row2) return error(400, "TOKEN_INVALID", "\u9023\u7D50\u5DF2\u5931\u6548\u6216\u5DF2\u4F7F\u7528\uFF0C\u8ACB\u91CD\u65B0\u7533\u8ACB\u3002");
          const changed = await tx.run("UPDATE auth_challenges SET used_at=? WHERE token_hash=? AND used_at IS NULL", [now, hash(rawToken)]);
          if (!changed) return error(409, "TOKEN_USED", "\u9023\u7D50\u5DF2\u4F7F\u7528\u3002");
          if (passwordHash) {
            await tx.run("UPDATE users SET password_hash=? WHERE id=?", [passwordHash, row2.user_id]);
            await tx.run("DELETE FROM sessions WHERE user_id=?", [row2.user_id]);
          } else await tx.run("UPDATE users SET email_verified_at=? WHERE id=?", [now, row2.user_id]);
          await audit(tx, row2.user_id, row2.user_id, kind, row2.user_id, {}, now);
        });
        send(200, { completed: true });
        return true;
      }
      const auth = requireRole(session, ["customer", "admin", "buyer", "warehouse"]), user = auth.user;
      if (path.startsWith("/staff/")) {
        requireRole(auth, ["admin", "buyer", "warehouse"]);
        if (config.adminOrigin && origin !== config.adminOrigin && (writing || Boolean(origin))) return error(403, "STAFF_ORIGIN_REQUIRED", "\u8ACB\u7531\u8077\u54E1\u5DE5\u4F5C\u53F0\u9032\u884C\u64CD\u4F5C\u3002");
      }
      const key = String(req.headers["idempotency-key"] || "");
      if (path === "/auth/logout" && method === "POST") {
        await db.transaction(async (tx) => {
          await tx.run("DELETE FROM sessions WHERE id_hash=?", [auth.sessionHash]);
          await audit(tx, user.id, user.id, "logout", user.id, {}, service.now());
        });
        res.setHeader("Set-Cookie", sessionCookie(config, "", true));
        send(200, { loggedOut: true });
      } else if (path === "/bootstrap" && method === "GET") send(200, await service.bootstrap(user));
      else if (path === "/profile" && method === "PATCH") {
        const name = text2(body.name, "\u59D3\u540D", 100), phone = text2(body.phone, "\u96FB\u8A71", 50, true);
        const preferences = body.notificationPreferences === void 0 ? user.notificationPreferences || { email: true, sms: false } : object2(body.notificationPreferences);
        if (typeof preferences.email !== "boolean" || typeof preferences.sms !== "boolean") return error(400, "INVALID_PREFERENCES", "\u901A\u77E5\u504F\u597D\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
        if (preferences.sms && !/^\+[1-9]\d{7,14}$/.test(phone)) return error(400, "SMS_PHONE_REQUIRED", "\u958B\u555F\u7C21\u8A0A\u8ACB\u586B\u5BEB\u570B\u969B\u683C\u5F0F\u624B\u6A5F\uFF0C\u4F8B\u5982 +886912345678\u3002");
        const result = await service.mutate(user, key, path, body, async (tx) => {
          await tx.run("UPDATE users SET name=?,phone=?,email_notifications=?,sms_notifications=? WHERE id=?", [name, phone, preferences.email ? 1 : 0, preferences.sms ? 1 : 0, user.id]);
          await audit(tx, user.id, user.id, "profile_updated", user.id, { notificationPreferences: preferences }, service.now());
          return { user: { ...user, name, phone, notificationPreferences: preferences } };
        });
        send(200, result);
      } else if (path === "/addresses" && method === "POST") {
        const address2 = address(body.address);
        send(201, await service.mutate(user, key, path, body, async (tx) => {
          const count = await tx.all("SELECT COUNT(*) AS total FROM addresses WHERE user_id=?", [user.id]);
          if (Number(count[0].total) >= 30) return error(409, "ADDRESS_LIMIT", "\u6700\u591A\u5132\u5B5830\u500B\u5730\u5740\u3002");
          const saved = { id: id(), address: address2, createdAt: service.now() };
          await tx.run("INSERT INTO addresses (id,user_id,payload,created_at) VALUES (?,?,?,?)", [saved.id, user.id, JSON.stringify(address2), saved.createdAt]);
          await audit(tx, user.id, user.id, "address_created", saved.id, {}, service.now());
          return { address: saved };
        }));
      } else if (/^\/addresses\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(method)) {
        const addressId = path.split("/")[2];
        send(200, await service.mutate(user, key, `${method}:${path}`, body, async (tx) => {
          const rows = await tx.all("SELECT created_at FROM addresses WHERE id=? AND user_id=?", [addressId, user.id]);
          if (!rows.length) return error(404, "ADDRESS_NOT_FOUND", "\u627E\u4E0D\u5230\u5730\u5740\u3002");
          if (method === "DELETE") {
            await tx.run("DELETE FROM addresses WHERE id=? AND user_id=?", [addressId, user.id]);
            await audit(tx, user.id, user.id, "address_deleted", addressId, {}, service.now());
            return { deleted: true };
          }
          const address2 = address(body.address);
          await tx.run("UPDATE addresses SET payload=? WHERE id=? AND user_id=?", [JSON.stringify(address2), addressId, user.id]);
          await audit(tx, user.id, user.id, "address_updated", addressId, {}, service.now());
          return { address: { id: addressId, address: address2, createdAt: rows[0].created_at } };
        }));
      } else if (path === "/orders/quote" && method === "POST") send(200, { quote: (await service.goodsQuote(body, user)).quote });
      else if (path === "/orders" && method === "POST") send(201, await service.createOrder(user, key, body));
      else if (/^\/orders\/[^/]+\/payment$/.test(path) && method === "POST") send(200, await service.payment(user, key, "order", path.split("/")[2], body));
      else if (/^\/orders\/[^/]+\/cancel$/.test(path) && method === "POST") send(200, await service.cancelOrder(user, key, path.split("/")[2]));
      else if (/^\/orders\/[^/]+\/refund$/.test(path) && method === "POST") send(201, await service.refundRequest(user, key, path.split("/")[2], body));
      else if (path === "/parcels" && method === "POST") send(201, await service.requestParcel(user, key, body));
      else if (/^\/parcels\/[^/]+\/payment$/.test(path) && method === "POST") send(200, await service.payment(user, key, "parcel", path.split("/")[2], body));
      else if (/^\/parcels\/[^/]+\/(submit|cancel|deliver)$/.test(path) && method === "POST") send(200, await service.parcelAction(user, key, path.split("/")[2], path.split("/")[3]));
      else if (path === "/notifications" && method === "GET") send(200, { notifications: await notificationsFor(db, user.id) });
      else if (/^\/notifications\/[^/]+\/read$/.test(path) && method === "POST") {
        const changed = await db.run("UPDATE notifications SET read_at=? WHERE id=? AND user_id=?", [service.now(), path.split("/")[2], user.id]);
        if (!changed) return error(404, "NOTIFICATION_NOT_FOUND", "\u627E\u4E0D\u5230\u901A\u77E5\u3002");
        send(200, { read: true });
      } else if (path === "/affiliate/me" && method === "GET") send(200, await affiliateFor(db, user.id));
      else if (path === "/affiliate/withdrawals" && method === "POST") send(201, await service.requestWithdrawal(user, key, body));
      else if (path === "/staff/affiliates" && method === "POST") send(200, await service.activateAffiliate(user, key, body));
      else if (path === "/staff/withdrawals" && method === "GET") {
        requireRole(auth, ["admin"]);
        send(200, { withdrawals: await withdrawalsFor(db) });
      } else if (/^\/staff\/withdrawals\/[^/]+$/.test(path) && method === "POST") send(200, await service.reviewWithdrawal(user, key, path.split("/")[3], body));
      else if (/^\/staff\/refunds\/[^/]+\/record$/.test(path) && method === "POST") send(200, await service.recordManualRefund(user, key, path.split("/")[3], body));
      else if (path === "/staff/procurement/tasks" && ["GET", "POST"].includes(method)) {
        if (!options.procurement) return error(503, "PROCUREMENT_NOT_CONFIGURED", "\u63A1\u8CFC\u7DB2\u95DC\u5C1A\u672A\u914D\u7F6E\uFF0C\u672A\u5411\u4F9B\u61C9\u5546\u4E0B\u55AE\u3002");
        send(method === "POST" ? 201 : 200, method === "POST" ? await options.procurement.create(user, key, body) : await options.procurement.list(user));
      } else if (/^\/staff\/procurement\/tasks\/[^/]+\/(quote|approve|execute|reconcile|cancel)$/.test(path) && method === "POST") {
        if (!options.procurement) return error(503, "PROCUREMENT_NOT_CONFIGURED", "\u63A1\u8CFC\u7DB2\u95DC\u5C1A\u672A\u914D\u7F6E\uFF0C\u672A\u5411\u4F9B\u61C9\u5546\u4E0B\u55AE\u3002");
        const action = path.split("/")[5];
        send(200, await options.procurement[action](user, key, path.split("/")[4], body));
      } else if (path === "/staff/dashboard" && method === "GET") {
        const dashboard = await service.staffDashboard(user);
        if (user.role === "admin" && options.procurement) dashboard.providers = [...dashboard.providers || [], (await options.procurement.list(user)).provider];
        send(200, dashboard);
      } else if (path === "/staff/scan" && method === "POST") send(200, await service.scan(user, body.trackingNumber));
      else if (path === "/staff/commands" && method === "POST") send(200, await service.staffCommand(user, key, body));
      else if (path === "/staff/settings" && method === "PATCH") send(200, await service.updateSettings(user, key, body.settings ?? body));
      else if (path === "/staff/refunds" && method === "GET") {
        requireRole(auth, ["admin"]);
        send(200, { refunds: await db.all("SELECT * FROM refund_requests ORDER BY created_at DESC LIMIT 200") });
      } else if (/^\/staff\/refunds\/[^/]+$/.test(path) && method === "POST") send(200, await service.reviewRefund(user, key, path.split("/")[3], body));
      else return error(404, "NOT_FOUND", "\u627E\u4E0D\u5230\u6B64\u670D\u52D9\u3002");
    } catch (reason) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      if (reason instanceof PlatformError) send(reason.status, { error: { code: reason.code, message: reason.message } });
      else if (reason instanceof IntegrationError) send(reason.code === "invalid_signature" ? 400 : reason.code === "not_configured" ? 503 : 502, { error: { code: `INTEGRATION_${reason.code.toUpperCase()}`, message: reason.code === "invalid_signature" ? "\u652F\u4ED8\u7C3D\u7AE0\u4E0D\u6B63\u78BA\u3002" : "\u5916\u90E8\u670D\u52D9\u5C1A\u672A\u78BA\u8A8D\u6B64\u64CD\u4F5C\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u8A66\u3002" } });
      else send(500, { error: { code: "PLATFORM_UNAVAILABLE", message: "\u670D\u52D9\u66AB\u6642\u7121\u6CD5\u5B8C\u6210\u64CD\u4F5C\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002" } });
    }
    return true;
  };
  return Object.assign(handler, { service });
}

// server/platform/outbox.ts
function createOutboxStore(db) {
  return {
    async claimBatch({ limit, workerId, now }) {
      return db.transaction(async (tx) => {
        await tx.run("UPDATE outbox SET status='unknown' WHERE status='processing' AND next_attempt_at<=?", [now]);
        const rows = await tx.all(`SELECT o.id,o.kind,o.payload,u.email,u.phone FROM outbox o JOIN users u ON u.id=o.user_id WHERE o.status='pending' AND o.next_attempt_at<=? ORDER BY o.created_at LIMIT ?${tx.dialect === "postgres" ? " FOR UPDATE OF o SKIP LOCKED" : ""}`, [now, Math.min(50, Math.max(1, limit))]);
        const messages = [];
        for (const row2 of rows) {
          const payload = JSON.parse(row2.payload);
          if (!["email", "sms"].includes(row2.kind) || !payload.text) {
            await tx.run("UPDATE outbox SET status='rejected' WHERE id=?", [row2.id]);
            continue;
          }
          const claimed = await tx.run("UPDATE outbox SET status='processing',attempts=attempts+1,next_attempt_at=?,payload=? WHERE id=? AND status='pending'", [new Date(Date.parse(now) + 5 * 6e4).toISOString(), JSON.stringify({ ...payload, workerId }), row2.id]);
          if (claimed) messages.push({ id: row2.id, channel: row2.kind, idempotencyKey: `notification-${row2.id}`, to: payload.to || (row2.kind === "email" ? row2.email : row2.phone), subject: payload.subject, text: payload.text });
        }
        return messages;
      });
    },
    async finish(id2, outcome) {
      await db.transaction(async (tx) => {
        const row2 = (await tx.all("SELECT payload FROM outbox WHERE id=? AND status='processing'", [id2]))[0];
        if (!row2) throw new Error("Notification lease is not active.");
        const payload = JSON.parse(row2.payload);
        if (outcome.state === "accepted") {
          delete payload.text;
          delete payload.to;
        }
        await tx.run("UPDATE outbox SET status=?,payload=? WHERE id=?", [outcome.state, JSON.stringify({ ...payload, outcome }), id2]);
      });
    }
  };
}

// server/integrations/procurement.ts
import { createHash as createHash2, createHmac, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
function validateRequest(input) {
  assertReference(input.reference);
  assertReference(input.buyerAccountId);
  assertReference(input.shippingAddressId);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new IntegrationError("invalid_request", "Invalid procurement items.");
  const seen = /* @__PURE__ */ new Set();
  for (const item of input.items) {
    if (item.source !== "1688" || !/^\d{5,30}$/.test(item.productId) || !/^[A-Za-z0-9_:;-]{1,200}$/.test(item.skuId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1e4) throw new IntegrationError("invalid_request", "Invalid procurement SKU or quantity.");
    const key = `${item.productId}/${item.skuId}`;
    if (seen.has(key)) throw new IntegrationError("invalid_request", "Combine duplicate procurement SKU lines first.");
    seen.add(key);
  }
}
function procurementRequestFingerprint(input) {
  validateRequest(input);
  return createHash2("sha256").update(JSON.stringify({
    reference: input.reference,
    buyerAccountId: input.buyerAccountId,
    shippingAddressId: input.shippingAddressId,
    items: input.items.map((i) => ({ source: i.source, productId: i.productId, skuId: i.skuId, quantity: i.quantity })).sort((a, b) => `${a.productId}/${a.skuId}`.localeCompare(`${b.productId}/${b.skuId}`))
  })).digest("hex");
}
function procurementQuoteDigest(quote) {
  return createHash2("sha256").update(JSON.stringify([
    quote.quoteId,
    quote.reference,
    quote.requestFingerprint,
    quote.currency,
    quote.merchandiseMinor,
    quote.domesticShippingMinor,
    quote.totalMinor,
    quote.expiresAt
  ])).digest("hex");
}
function validateQuote(value, request, now) {
  const q = object3(value);
  assertReference(q.quoteId, "quote ID");
  assertMinor(q.merchandiseMinor);
  assertMinor(q.totalMinor);
  if (q.reference !== request.reference || q.requestFingerprint !== procurementRequestFingerprint(request) || q.currency !== "CNY" || !Number.isSafeInteger(q.domesticShippingMinor) || q.domesticShippingMinor < 0 || q.merchandiseMinor + q.domesticShippingMinor !== q.totalMinor || typeof q.expiresAt !== "string" || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= now || Date.parse(q.expiresAt) > now + 15 * 6e4) throw new IntegrationError("confirmation_required", "Procurement quote is invalid, changed or expired.");
  return q;
}
function validateReceipt(value, request, total) {
  const r = object3(value);
  assertMinor(r.totalMinor);
  if (r.reference !== request.reference || r.requestFingerprint !== procurementRequestFingerprint(request) || r.currency !== "CNY" || total !== void 0 && r.totalMinor !== total || !["awaiting_supplier_payment", "supplier_paid"].includes(String(r.status)) || !Array.isArray(r.supplierOrderIds) || !r.supplierOrderIds.length || r.supplierOrderIds.length > 100 || r.supplierOrderIds.some((id2) => typeof id2 !== "string" || !/^\d{5,40}$/.test(id2)) || new Set(r.supplierOrderIds).size !== r.supplierOrderIds.length) {
    throw new IntegrationError("unknown_outcome", "Procurement result could not be reconciled.");
  }
  return r;
}
function signProcurementGatewayRequest(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
function createProcurementAdapter(env = process.env, dependencies = {}) {
  const url = validHttpsUrl(env.PROCUREMENT_GATEWAY_URL);
  const secret = env.PROCUREMENT_GATEWAY_SECRET || "";
  const configured = env.PROCUREMENT_GATEWAY_ENABLED === "true" && !!url && !url.search && !url.hash && secret.length >= 32 && !!dependencies.journal;
  const status = configured ? { provider: "authorized_procurement_gateway", configured: true, mode: "live", capabilities: ["supplier_quote", "create_unpaid_order", "lookup_order"], reason: "CNBUY gateway configured; supplier payment remains a separate authorized operation." } : unavailable("authorized_procurement_gateway", "No authorized procurement gateway plus durable idempotency journal is connected. TMAPI catalog access cannot place or pay orders.");
  const now = dependencies.now || Date.now;
  async function call(path, data, idempotencyKey) {
    if (!configured) throw new IntegrationError("not_configured", status.reason);
    const body = JSON.stringify(data);
    const timestamp = String(now());
    let response;
    try {
      response = await (dependencies.fetcher || fetch)(`${url.href.replace(/\/$/, "")}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25e3),
        headers: {
          "Content-Type": "application/json",
          "X-CNBUY-Timestamp": timestamp,
          "X-CNBUY-Signature": signProcurementGatewayRequest(secret, timestamp, body),
          ...idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}
        },
        body
      });
    } catch {
      throw new IntegrationError("unknown_outcome", "Procurement outcome unknown; reconcile before any retry.");
    }
    if (!response.ok) throw new IntegrationError(response.status >= 500 ? "unknown_outcome" : "provider_rejected", "Procurement gateway did not confirm this request.");
    return response.json().catch(() => {
      throw new IntegrationError("unknown_outcome", "Invalid procurement gateway response.");
    });
  }
  return {
    status,
    async quote(request) {
      validateRequest(request);
      return validateQuote(await call("/v1/quotes", { ...request, requestFingerprint: procurementRequestFingerprint(request) }), request, now());
    },
    async createOrder(request, quote, approval, idempotencyKey) {
      if (!configured) throw new IntegrationError("not_configured", status.reason);
      validateRequest(request);
      assertReference(idempotencyKey, "procurement idempotency key");
      assertReference(approval.approvedBy, "approver ID");
      const approvedAt = Date.parse(approval.approvedAt);
      if (approval.quoteDigest !== procurementQuoteDigest(quote) || approval.confirmedTotalMinor !== quote.totalMinor || !Number.isFinite(approvedAt) || approvedAt > now() || now() - approvedAt > 15 * 6e4) throw new IntegrationError("confirmation_required", "An authorized buyer must confirm this exact quote and amount.");
      const fingerprint = createHash2("sha256").update(procurementRequestFingerprint(request) + approval.quoteDigest).digest("hex");
      validateQuote(quote, request, now());
      const claim = await dependencies.journal.claim(idempotencyKey, fingerprint);
      if (!claim.acquired) {
        if (claim.record.fingerprint !== fingerprint) throw new IntegrationError("conflict", "Procurement idempotency key reused with different data.");
        if (claim.record.state === "created" && claim.record.receipt) return validateReceipt(claim.record.receipt, request, quote.totalMinor);
        throw new IntegrationError("unknown_outcome", "Procurement is in progress or uncertain; reconcile before retrying.");
      }
      try {
        const receipt = validateReceipt(await call("/v1/orders", {
          request,
          quoteId: quote.quoteId,
          requestFingerprint: procurementRequestFingerprint(request),
          maxTotalMinor: approval.confirmedTotalMinor,
          currency: "CNY",
          paymentMode: "manual",
          approval
        }, idempotencyKey), request, quote.totalMinor);
        if (receipt.status !== "awaiting_supplier_payment") throw new IntegrationError("unknown_outcome", "Unexpected supplier payment state; reconcile separately.");
        await dependencies.journal.save(idempotencyKey, { fingerprint, state: "created", receipt });
        return receipt;
      } catch (error2) {
        await dependencies.journal.save(idempotencyKey, { fingerprint, state: "unknown" });
        throw error2;
      }
    },
    async reconcile(request) {
      validateRequest(request);
      const result = await call("/v1/orders/by-reference", { reference: request.reference, buyerAccountId: request.buyerAccountId });
      if (result === null) return null;
      return validateReceipt(result, request);
    }
  };
}

// server/platform/procurement.ts
function fromRow(row2) {
  const quote = row2.quote_json ? JSON.parse(row2.quote_json) : void 0;
  const receipt = row2.receipt_json ? JSON.parse(row2.receipt_json) : void 0;
  return {
    id: row2.id,
    orderId: row2.order_id,
    lineIds: JSON.parse(row2.line_ids_json),
    userId: row2.user_id,
    request: JSON.parse(row2.request_json),
    status: row2.status,
    version: Number(row2.version),
    ...quote ? { quote, quoteDigest: procurementQuoteDigest(quote) } : {},
    ...row2.approval_json ? { approval: JSON.parse(row2.approval_json) } : {},
    ...receipt ? { receipt, requiresManualMapping: receipt.status === "supplier_paid" && receipt.supplierOrderIds.length !== 1 } : {},
    createdAt: row2.created_at,
    updatedAt: row2.updated_at
  };
}
async function taskById(tx, id2) {
  const row2 = (await tx.all("SELECT * FROM procurement_tasks WHERE id=?", [id2]))[0];
  if (!row2) return error(404, "PROCUREMENT_NOT_FOUND", "\u627E\u4E0D\u5230\u63A1\u8CFC\u4EFB\u52D9\u3002");
  return fromRow(row2);
}
async function saveTask(tx, task) {
  await tx.run("UPDATE procurement_tasks SET quote_json=?,approval_json=?,receipt_json=?,status=?,updated_at=?,version=? WHERE id=?", [
    task.quote ? JSON.stringify(task.quote) : null,
    task.approval ? JSON.stringify(task.approval) : null,
    task.receipt ? JSON.stringify(task.receipt) : null,
    task.status,
    task.updatedAt,
    task.version,
    task.id
  ]);
}
function buyer(user) {
  if (!["admin", "buyer"].includes(user.role)) error(403, "FORBIDDEN", "\u53EA\u6709\u7BA1\u7406\u54E1\u6216\u63A1\u8CFC\u54E1\u53EF\u64CD\u4F5C\u81EA\u52D5\u63A1\u8CFC\u4EFB\u52D9\u3002");
}
function operationKey(key) {
  if (!/^[A-Za-z\d_-]{16,100}$/.test(key)) error(400, "IDEMPOTENCY_REQUIRED", "\u8ACB\u63D0\u4F9B\u6709\u6548\u64CD\u4F5C\u8B58\u5225\u78BC\u3002");
}
function canonical2(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical2).join(",")}]` : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical2(v)}`).join(",")}}`;
}
function createProcurementJournal(db) {
  return {
    claim: (key, fingerprint) => db.transaction(async (tx) => {
      const inserted = await tx.run("INSERT INTO procurement_journal (key,fingerprint,state,receipt_json) VALUES (?,?,'submitting',NULL) ON CONFLICT(key) DO NOTHING", [key, fingerprint]);
      if (inserted) return { acquired: true };
      const row2 = (await tx.all("SELECT fingerprint,state,receipt_json FROM procurement_journal WHERE key=?", [key]))[0];
      if (!row2) throw new IntegrationError("unknown_outcome", "Procurement journal unavailable.");
      return { acquired: false, record: { fingerprint: row2.fingerprint, state: row2.state, ...row2.receipt_json ? { receipt: JSON.parse(row2.receipt_json) } : {} } };
    }),
    async save(key, record) {
      const changed = await db.run("UPDATE procurement_journal SET state=?,receipt_json=? WHERE key=? AND fingerprint=?", [record.state, record.receipt ? JSON.stringify(record.receipt) : null, key, record.fingerprint]);
      if (!changed) throw new IntegrationError("conflict", "Procurement journal fingerprint changed.");
    }
  };
}
var ProcurementService = class {
  constructor(options) {
    this.options = options;
  }
  options;
  now() {
    return (this.options.now?.() || /* @__PURE__ */ new Date()).toISOString();
  }
  ready() {
    if (!this.options.adapter.status.configured || !this.options.buyerAccountId || !this.options.shippingAddressId) error(503, "PROCUREMENT_NOT_CONFIGURED", "\u63A1\u8CFC\u7DB2\u95DC\u3001\u8CB7\u5BB6\u6388\u6B0A\u5E33\u865F\u6216\u4E2D\u570B\u5009\u5730\u5740\u5C1A\u672A\u914D\u7F6E\uFF1B\u672A\u5411\u4F9B\u61C9\u5546\u4E0B\u55AE\u3002");
  }
  async locks(tx, user, owner) {
    for (const id2 of [.../* @__PURE__ */ new Set([user.id, owner])].sort()) await lockUser(tx, id2);
  }
  buildRequest(order, lineIds, reference) {
    if (order.paymentStatus !== "paid") error(409, "GOODS_UNPAID", "\u53EA\u6709\u5DF2\u78BA\u8A8D\u4ED8\u6B3E\u7684\u5546\u54C1\u53EF\u4EE5\u5EFA\u7ACB\u63A1\u8CFC\u4EFB\u52D9\u3002");
    const items = [];
    for (const lineId of lineIds) {
      const line = order.lines.find((line2) => line2.id === lineId);
      if (!line || line.status !== "purchasing") return error(409, "LINE_NOT_PURCHASABLE", "\u9078\u4E2D\u5546\u54C1\u4E0D\u5728\u5F85\u63A1\u8CFC\u72C0\u614B\u3002");
      const p = line.product, skuId = line.item.skuId;
      if (p.source !== "1688" || p.isImported !== true || p.detailsLoaded === false || !/^\d{5,30}$/.test(p.sourceProductId || "") || !skuId || !p.variants?.some((variant) => variant.id === skuId)) return error(409, "SOURCE_SKU_REQUIRED", "\u81EA\u52D5\u63A1\u8CFC\u9700\u8981\u771F\u5BE61688\u5546\u54C1\u7DE8\u865F\u8207\u5B8C\u6574SKU\uFF1B\u6B64\u5546\u54C1\u8ACB\u4EBA\u5DE5\u6838\u5C0D\u3002");
      const previous = items.find((item) => item.productId === p.sourceProductId && item.skuId === skuId);
      if (previous) previous.quantity += line.quantity;
      else items.push({ source: "1688", productId: p.sourceProductId, skuId, quantity: line.quantity });
    }
    const request = { reference, buyerAccountId: this.options.buyerAccountId || "not-configured", shippingAddressId: this.options.shippingAddressId || "not-configured", items };
    procurementRequestFingerprint(request);
    return request;
  }
  usableQuote(task) {
    const q = task.quote;
    if (!q || q.currency !== "CNY" || q.reference !== task.id || q.requestFingerprint !== procurementRequestFingerprint(task.request) || !Number.isSafeInteger(q.totalMinor) || q.totalMinor <= 0 || !Number.isSafeInteger(q.merchandiseMinor) || q.merchandiseMinor <= 0 || !Number.isSafeInteger(q.domesticShippingMinor) || q.domesticShippingMinor < 0 || q.totalMinor !== q.merchandiseMinor + q.domesticShippingMinor || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= Date.parse(this.now()) || Date.parse(q.expiresAt) > Date.parse(this.now()) + 15 * 6e4) {
      return error(409, "PROCUREMENT_QUOTE_EXPIRED", "\u63A1\u8CFC\u5831\u50F9\u5DF2\u5931\u6548\u6216\u91D1\u984D\u4E0D\u4E00\u81F4\uFF0C\u8ACB\u91CD\u65B0\u5831\u50F9\u3002");
    }
    return q;
  }
  async list(user) {
    buyer(user);
    const tasks = (await this.options.database.all("SELECT * FROM procurement_tasks ORDER BY created_at DESC LIMIT 200")).map(fromRow);
    const configured = this.options.adapter.status.configured && Boolean(this.options.buyerAccountId && this.options.shippingAddressId);
    return { tasks, provider: configured ? this.options.adapter.status : { ...this.options.adapter.status, configured: false, mode: "unavailable", reason: "\u63A1\u8CFC\u7DB2\u95DC\u3001\u8CB7\u5BB6\u5E33\u865F\u6216\u4E2D\u570B\u5009\u5730\u5740\u672A\u914D\u7F6E\u3002" } };
  }
  async create(user, key, input) {
    buyer(user);
    operationKey(key);
    const body = object2(input), orderId = text2(body.orderId, "\u8A02\u55AE\u7DE8\u865F");
    if (!Array.isArray(body.lineIds) || !body.lineIds.length || body.lineIds.length > 40) error(400, "INVALID_LINES", "\u8ACB\u9078\u64C71\u201340\u500B\u5F85\u63A1\u8CFC\u5546\u54C1\u884C\u3002");
    const lineIds = body.lineIds.map((value) => text2(value, "\u5546\u54C1\u884C\u7DE8\u865F")).sort();
    if (new Set(lineIds).size !== lineIds.length) error(400, "DUPLICATE_LINES", "\u5546\u54C1\u884C\u4E0D\u53EF\u91CD\u8907\u3002");
    const id2 = `PR-${hash(`${user.id}:${key}`).slice(0, 32)}`, db = this.options.database;
    const owner = (await orderById(db, orderId)).userId;
    const task = await db.transaction(async (tx) => {
      await this.locks(tx, user, owner);
      const previous = (await tx.all("SELECT * FROM procurement_tasks WHERE id=?", [id2]))[0];
      if (previous) {
        const task2 = fromRow(previous);
        if (task2.orderId !== orderId || canonical2(task2.lineIds) !== canonical2(lineIds)) error(409, "IDEMPOTENCY_CONFLICT", "\u76F8\u540C\u8B58\u5225\u78BC\u4E0D\u80FD\u5EFA\u7ACB\u4E0D\u540C\u63A1\u8CFC\u4EFB\u52D9\u3002");
        return task2;
      }
      const order = await orderById(tx, orderId);
      const active = await tx.all("SELECT line_ids_json FROM procurement_tasks WHERE order_id=? AND status<>'canceled'", [orderId]);
      if (active.some((row2) => JSON.parse(row2.line_ids_json).some((id3) => lineIds.includes(id3)))) error(409, "PROCUREMENT_ALREADY_QUEUED", "\u5546\u54C1\u5DF2\u6709\u63A1\u8CFC\u4EFB\u52D9\uFF0C\u8ACB\u5148\u8655\u7406\u539F\u4EFB\u52D9\uFF0C\u907F\u514D\u91CD\u8907\u63A1\u8CFC\u3002");
      const request = this.buildRequest(order, lineIds, id2), now = this.now();
      await tx.run("INSERT INTO procurement_tasks (id,order_id,line_ids_json,user_id,request_json,quote_json,approval_json,receipt_json,status,created_at,updated_at,version) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)", [id2, orderId, JSON.stringify(lineIds), owner, JSON.stringify(request), "draft", now, now, 1]);
      await audit(tx, user.id, owner, "procurement_task_created", id2, { orderId, lineIds }, now);
      return taskById(tx, id2);
    });
    return { task };
  }
  async mutate(user, key, id2, action, input, work) {
    buyer(user);
    operationKey(key);
    const initial = await taskById(this.options.database, id2), route = `/staff/procurement/tasks/${id2}/${action}`, requestHash = hash(canonical2(input));
    return this.options.database.transaction(async (tx) => {
      await this.locks(tx, user, initial.userId);
      const previous = (await tx.all("SELECT route,request_hash FROM idempotency WHERE user_id=? AND key=?", [user.id, key]))[0];
      if (previous) {
        if (previous.route !== route || previous.request_hash !== requestHash) error(409, "IDEMPOTENCY_CONFLICT", "\u6B64\u64CD\u4F5C\u8B58\u5225\u78BC\u5DF2\u7528\u65BC\u5176\u4ED6\u5167\u5BB9\u3002");
        return { task: await taskById(tx, id2), fresh: false };
      }
      const task = await taskById(tx, id2);
      await work(tx, task);
      task.updatedAt = this.now();
      task.version++;
      await saveTask(tx, task);
      await tx.run("INSERT INTO idempotency (user_id,key,route,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)", [user.id, key, route, requestHash, JSON.stringify({ taskId: id2 }), this.now()]);
      await audit(tx, user.id, task.userId, `procurement_${action}`, id2, { status: task.status, version: task.version }, this.now());
      return { task, fresh: true };
    });
  }
  async finish(user, id2, work, expectedVersion) {
    const initial = await taskById(this.options.database, id2);
    return this.options.database.transaction(async (tx) => {
      await this.locks(tx, user, initial.userId);
      const task = await taskById(tx, id2);
      if (expectedVersion !== void 0 && task.version !== expectedVersion) return { task };
      await work(tx, task);
      task.updatedAt = this.now();
      task.version++;
      await saveTask(tx, task);
      await audit(tx, user.id, task.userId, "procurement_result", id2, { status: task.status }, this.now());
      return { task };
    });
  }
  async quote(user, key, id2, input) {
    buyer(user);
    this.ready();
    const body = object2(input);
    const reserved = await this.mutate(user, key, id2, "quote", input, async (tx, task) => {
      version(task, body.expectedVersion);
      const staleQuote = task.status === "quoting" && Date.parse(this.now()) - Date.parse(task.updatedAt) > 12e4;
      if (!["draft", "quote_failed", "quoted", "approved"].includes(task.status) && !staleQuote) error(409, "PROCUREMENT_STATE", "\u6B64\u4EFB\u52D9\u76EE\u524D\u4E0D\u80FD\u91CD\u65B0\u5831\u50F9\uFF1B\u903E\u6642\u7684\u5831\u50F9\u53EF\u65BC\u5169\u5206\u9418\u5F8C\u91CD\u65B0\u67E5\u8A62\u3002");
      const order = await orderById(tx, task.orderId), request = this.buildRequest(order, task.lineIds, id2);
      task.request = request;
      await tx.run("UPDATE procurement_tasks SET request_json=? WHERE id=?", [JSON.stringify(request), id2]);
      task.status = "quoting";
      delete task.quote;
      delete task.quoteDigest;
      delete task.approval;
    });
    if (!reserved.fresh) return { task: reserved.task };
    try {
      const quote = await this.options.adapter.quote(reserved.task.request);
      return await this.finish(user, id2, async (_tx, task) => {
        task.quote = quote;
        this.usableQuote(task);
        task.quoteDigest = procurementQuoteDigest(quote);
        task.status = "quoted";
      }, reserved.task.version);
    } catch (reason) {
      await this.finish(user, id2, async (_tx, task) => {
        task.status = "quote_failed";
        delete task.quote;
        delete task.quoteDigest;
      }, reserved.task.version);
      throw reason;
    }
  }
  async approve(user, key, id2, input) {
    buyer(user);
    const body = object2(input);
    const result = await this.mutate(user, key, id2, "approve", input, async (_tx, task) => {
      version(task, body.expectedVersion);
      if (task.status !== "quoted") error(409, "PROCUREMENT_STATE", "\u8ACB\u5148\u53D6\u5F97\u7576\u524D\u63A1\u8CFC\u5831\u50F9\u3002");
      const quote = this.usableQuote(task), digest = procurementQuoteDigest(quote);
      if (body.quoteDigest !== digest || body.confirmedTotalMinor !== quote.totalMinor) error(409, "PROCUREMENT_AMOUNT_CHANGED", "\u8ACB\u78BA\u8A8D\u672C\u6B21\u5831\u50F9\u7684\u5B8C\u6574\u4EBA\u6C11\u5E63\u91D1\u984D\u3002");
      task.approval = { quoteDigest: digest, confirmedTotalMinor: quote.totalMinor, approvedBy: user.id, approvedAt: this.now() };
      task.status = "approved";
    });
    return { task: result.task };
  }
  async applyReceipt(tx, task, receipt) {
    if (receipt.reference !== task.id || receipt.currency !== "CNY" || receipt.requestFingerprint !== procurementRequestFingerprint(task.request) || receipt.totalMinor !== task.quote?.totalMinor || !receipt.supplierOrderIds?.length || receipt.supplierOrderIds.some((id2) => !/^\d{5,40}$/.test(id2))) error(409, "PROCUREMENT_RECEIPT_MISMATCH", "\u4F9B\u61C9\u5546\u7D50\u679C\u8207\u5DF2\u6838\u51C6\u63A1\u8CFC\u4EFB\u52D9\u4E0D\u4E00\u81F4\uFF0C\u9700\u4EBA\u5DE5\u5C0D\u5E33\u3002");
    if (task.receipt?.status === "supplier_paid") {
      if (receipt.status !== "supplier_paid") return;
      if (canonical2([...task.receipt.supplierOrderIds].sort()) !== canonical2([...receipt.supplierOrderIds].sort())) error(409, "PROCUREMENT_RECEIPT_MISMATCH", "\u5DF2\u6838\u5C0D\u7684\u4F9B\u61C9\u5546\u8A02\u55AE\u865F\u767C\u751F\u8B8A\u66F4\uFF0C\u9700\u4EBA\u5DE5\u6838\u5C0D\u3002");
      return;
    }
    task.receipt = receipt;
    task.status = receipt.status;
    task.requiresManualMapping = receipt.status === "supplier_paid" && receipt.supplierOrderIds.length !== 1;
    if (receipt.status === "supplier_paid" && receipt.supplierOrderIds.length === 1) {
      const order = await orderById(tx, task.orderId);
      if (order.paymentStatus !== "paid") error(409, "PROCUREMENT_ORDER_CHANGED", "\u5BA2\u6236\u8A02\u55AE\u4ED8\u6B3E\u72C0\u614B\u5DF2\u8B8A\u66F4\uFF0C\u9700\u4EBA\u5DE5\u5C0D\u5E33\u3002");
      for (const id2 of task.lineIds) {
        const line = order.lines.find((line2) => line2.id === id2);
        if (!line || !["purchasing", "purchased"].includes(line.status) || line.supplierOrderNo && line.supplierOrderNo !== receipt.supplierOrderIds[0]) return error(409, "PROCUREMENT_LINE_CHANGED", "\u5546\u54C1\u884C\u5DF2\u7531\u5176\u4ED6\u64CD\u4F5C\u8B8A\u66F4\uFF0C\u9700\u4EBA\u5DE5\u6838\u5C0D\u3002");
        line.supplierOrderNo = receipt.supplierOrderIds[0];
        line.status = "purchased";
      }
      order.version++;
      order.events.push({ at: this.now(), type: "supplier_payment_reconciled", note: `\u63A1\u8CFC\u4EFB\u52D9 ${task.id} \u5DF2\u67E5\u8A62\u78BA\u8A8D\u4F9B\u61C9\u5546\u4ED8\u6B3E\u3002` });
      await saveOrder(tx, order);
    }
  }
  async execute(user, key, id2, input) {
    buyer(user);
    this.ready();
    const body = object2(input);
    const reserved = await this.mutate(user, key, id2, "execute", input, async (tx, task) => {
      version(task, body.expectedVersion);
      if (task.status !== "approved" || !task.approval) error(409, "PROCUREMENT_STATE", "\u53EA\u6709\u5DF2\u6838\u51C6\u4EFB\u52D9\u53EF\u57F7\u884C\uFF1B\u9032\u884C\u4E2D\u6216\u672A\u77E5\u7D50\u679C\u53EA\u80FD\u5C0D\u5E33\u3002");
      const current = this.buildRequest(await orderById(tx, task.orderId), task.lineIds, id2);
      if (procurementRequestFingerprint(current) !== procurementRequestFingerprint(task.request)) error(409, "PROCUREMENT_REQUEST_CHANGED", "\u8CB7\u5BB6\u3001\u5730\u5740\u6216\u5546\u54C1\u5DF2\u8B8A\u66F4\uFF0C\u8ACB\u91CD\u65B0\u5831\u50F9\u3002");
      this.usableQuote(task);
      task.status = "submitting";
    });
    if (!reserved.fresh) return { task: reserved.task };
    try {
      const receipt = await this.options.adapter.createOrder(reserved.task.request, reserved.task.quote, reserved.task.approval, `procurement:${id2}`);
      return await this.finish(user, id2, (tx, task) => this.applyReceipt(tx, task, receipt));
    } catch (reason) {
      await this.finish(user, id2, async (_tx, task) => {
        if (task.status === "submitting") task.status = "unknown";
      });
      throw reason;
    }
  }
  async reconcile(user, key, id2, input) {
    buyer(user);
    this.ready();
    object2(input);
    const reserved = await this.mutate(user, key, id2, "reconcile", input, async (_tx, task) => {
      if (!["submitting", "unknown", "awaiting_supplier_payment", "supplier_paid"].includes(task.status)) error(409, "PROCUREMENT_STATE", "\u53EA\u6709\u5DF2\u63D0\u4EA4\u6216\u7D50\u679C\u672A\u77E5\u7684\u4EFB\u52D9\u9700\u8981\u5C0D\u5E33\u3002");
    });
    if (!reserved.fresh) return { task: reserved.task };
    const receipt = await this.options.adapter.reconcile(reserved.task.request);
    return this.finish(user, id2, async (tx, task) => {
      if (receipt) await this.applyReceipt(tx, task, receipt);
      else if (task.status !== "supplier_paid") task.status = "unknown";
    });
  }
  async cancel(user, key, id2, input) {
    buyer(user);
    const body = object2(input);
    const result = await this.mutate(user, key, id2, "cancel", input, async (_tx, task) => {
      version(task, body.expectedVersion);
      if (!["draft", "quote_failed", "quoted", "approved"].includes(task.status)) error(409, "PROCUREMENT_STATE", "\u5DF2\u63D0\u4EA4\u6216\u7D50\u679C\u672A\u77E5\u7684\u63A1\u8CFC\u4E0D\u80FD\u76F4\u63A5\u53D6\u6D88\uFF0C\u8ACB\u5148\u5C0D\u5E33\u3002");
      task.status = "canceled";
    });
    return { task: result.task };
  }
};
function createProcurementServiceFromEnv(database, env = process.env) {
  return new ProcurementService({
    database,
    adapter: createProcurementAdapter(env, { journal: createProcurementJournal(database) }),
    buyerAccountId: env.PROCUREMENT_BUYER_ACCOUNT_ID,
    shippingAddressId: env.PROCUREMENT_SHIPPING_ADDRESS_ID
  });
}

// server/integrations/payments.ts
import { createHmac as createHmac2, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
function createPaymentAdapter(env = process.env, fetcher = fetch) {
  const mode = env.STRIPE_MODE;
  const secret = env.STRIPE_SECRET_KEY || "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || "";
  const app = validHttpsUrl(env.PUBLIC_APP_URL);
  const configured = (mode === "test" || mode === "live") && secret.startsWith(`sk_${mode}_`) && webhookSecret.startsWith("whsec_") && !!app;
  const status = configured ? { provider: "stripe", configured: true, mode, capabilities: ["hosted_card_checkout", "signed_payment_events"], reason: "Credentials configured; merchant activation and wallet eligibility must be verified separately." } : unavailable("stripe", "Requires matching STRIPE_MODE/STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and HTTPS PUBLIC_APP_URL.");
  const ready = () => {
    if (!configured) throw new IntegrationError("not_configured", status.reason);
  };
  return {
    status,
    async createPayment(input) {
      ready();
      assertReference(input.reference);
      assertReference(input.idempotencyKey, "idempotency key");
      assertMinor(input.amountMinor);
      if (!["TWD", "USD", "CNY"].includes(input.currency)) throw new IntegrationError("invalid_request", "Unsupported currency.");
      for (const value of [input.successUrl, input.cancelUrl]) {
        const url2 = validHttpsUrl(value);
        if (!url2 || url2.origin !== app.origin) throw new IntegrationError("invalid_request", "Checkout redirects must use the configured app origin.");
      }
      if (input.customerEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.customerEmail)) throw new IntegrationError("invalid_request", "Invalid customer email.");
      const form = new URLSearchParams({
        mode: "payment",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.reference,
        "metadata[reference]": input.reference,
        "payment_intent_data[metadata][reference]": input.reference,
        "payment_method_types[0]": "card",
        "line_items[0][price_data][currency]": input.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": String(input.amountMinor),
        "line_items[0][price_data][product_data][name]": "CNBUY order payment",
        "line_items[0][quantity]": "1"
      });
      if (input.customerEmail) form.set("customer_email", input.customerEmail);
      let response;
      try {
        response = await fetcher("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(2e4),
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": input.idempotencyKey },
          body: form.toString()
        });
      } catch {
        throw new IntegrationError("unknown_outcome", "Payment session outcome unknown; retry only with the same idempotency key.");
      }
      if (!response.ok) {
        const failure = object3(object3(await response.json().catch(() => null)).error);
        const uncertain = response.status >= 500 || [409, 429].includes(response.status) || failure.type === "idempotency_error";
        throw new IntegrationError(uncertain ? "unknown_outcome" : "provider_rejected", "Payment provider did not confirm the session.");
      }
      const data = object3(await response.json().catch(() => null));
      const url = validHttpsUrl(typeof data.url === "string" ? data.url : void 0);
      if (typeof data.id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(data.id) || !url || url.hostname !== "checkout.stripe.com" || data.client_reference_id !== input.reference || data.amount_total !== input.amountMinor || data.currency !== input.currency.toLowerCase() || data.livemode !== (mode === "live")) {
        throw new IntegrationError("unknown_outcome", "Payment session response could not be reconciled.");
      }
      return { provider: "stripe", providerPaymentId: data.id, checkoutUrl: url.href, status: "pending" };
    },
    verifyWebhook(rawBody, signature, now = Math.floor(Date.now() / 1e3)) {
      ready();
      if (Buffer.byteLength(rawBody) > 1e6 || typeof signature !== "string" || signature.length > 2048) throw new IntegrationError("invalid_signature", "Invalid payment signature.");
      const parts = signature.split(",").map((part) => part.trim().split("="));
      const timestamps = parts.filter(([key]) => key === "t");
      const timestamp = timestamps.length === 1 && /^\d+$/.test(timestamps[0][1] || "") ? Number(timestamps[0][1]) : NaN;
      if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now) || Math.abs(now - timestamp) > 300) throw new IntegrationError("invalid_signature", "Payment signature timestamp is invalid or expired.");
      const expected = createHmac2("sha256", webhookSecret).update(`${timestamp}.`).update(rawBody).digest();
      const valid = parts.some(([key, value]) => key === "v1" && /^[a-fA-F0-9]{64}$/.test(value || "") && timingSafeEqual3(expected, Buffer.from(value, "hex")));
      if (!valid) throw new IntegrationError("invalid_signature", "Invalid payment signature.");
      let event;
      try {
        event = object3(JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody));
      } catch {
        throw new IntegrationError("invalid_request", "Invalid payment event.");
      }
      if (event.livemode !== (mode === "live")) throw new IntegrationError("invalid_request", "Payment event mode does not match this deployment.");
      if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"].includes(String(event.type))) return null;
      const session = object3(object3(event.data).object);
      if (session.mode !== "payment" || session.object !== "checkout.session") throw new IntegrationError("invalid_request", "Invalid payment session event.");
      const expired = event.type === "checkout.session.expired";
      const failed = event.type === "checkout.session.async_payment_failed" || expired;
      if (expired && (session.status !== "expired" || session.payment_status === "paid")) throw new IntegrationError("invalid_request", "Invalid expired payment session.");
      if (!failed && session.payment_status !== "paid") return null;
      const reference = session.client_reference_id;
      assertReference(reference);
      if (object3(session.metadata).reference !== reference) throw new IntegrationError("invalid_request", "Payment reference mismatch.");
      assertMinor(session.amount_total);
      const currency3 = String(session.currency).toUpperCase();
      if (!["TWD", "USD", "CNY"].includes(currency3) || typeof event.id !== "string" || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || typeof session.id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(session.id) || !Number.isSafeInteger(event.created) || event.created <= 0 || event.created > 253402300799) {
        throw new IntegrationError("invalid_request", "Invalid payment event fields.");
      }
      return {
        provider: "stripe",
        eventId: event.id,
        providerPaymentId: session.id,
        reference,
        amountMinor: session.amount_total,
        currency: currency3,
        status: failed ? "failed" : "paid",
        occurredAt: new Date(event.created * 1e3).toISOString()
      };
    }
  };
}

// server/integrations/notifications.ts
import { createHash as createHash3 } from "node:crypto";
import nodemailer from "nodemailer";
var emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function validateEmail(input) {
  assertReference(input.idempotencyKey, "notification idempotency key");
  if (!emailPattern.test(input.to) || input.to.length > 254 || !input.subject || input.subject.length > 250 || /[\r\n]/.test(input.subject) || typeof input.text !== "string" || input.text.length < 1 || input.text.length > 5e4) throw new IntegrationError("invalid_request", "Invalid email notification.");
}
function createResendEmailAdapter(env = process.env, fetcher = fetch) {
  const apiKey = env.RESEND_API_KEY || "";
  const from = env.EMAIL_FROM || "";
  const configured = env.EMAIL_ENABLED === "true" && apiKey.startsWith("re_") && apiKey.length > 10 && emailPattern.test(from);
  const status = configured ? { provider: "resend", configured: true, mode: "live", capabilities: ["transactional_email", "provider_idempotency_24h"], reason: "Configured; sending-domain verification and actual delivery remain provider-side." } : unavailable("resend", "Requires EMAIL_ENABLED=true, RESEND_API_KEY and EMAIL_FROM on a verified sending domain.");
  return { status, async send(input) {
    if (!configured) throw new IntegrationError("not_configured", status.reason);
    validateEmail(input);
    let response;
    try {
      response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(2e4),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text })
      });
    } catch {
      throw new IntegrationError("unknown_outcome", "Email outcome unknown; reconcile or retry the identical idempotency key within provider retention.");
    }
    if (!response.ok) throw new IntegrationError(response.status >= 500 ? "unknown_outcome" : "provider_rejected", "Email provider did not accept the message.");
    const data = object3(await response.json().catch(() => null));
    if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(data.id)) throw new IntegrationError("unknown_outcome", "Email response could not be reconciled.");
    return { provider: "resend", messageId: data.id, status: "accepted" };
  } };
}
function createNotificationAdapters(env = process.env, dependencies = {}) {
  const smtpPort = Number(env.SMTP_PORT || "465");
  const smtpFrom = env.SMTP_FROM || "";
  const smtpConfigured = env.SMTP_ENABLED === "true" && !!env.SMTP_HOST && !!env.SMTP_USER && !!env.SMTP_PASSWORD && emailPattern.test(smtpFrom) && [465, 587].includes(smtpPort);
  const smtpStatus = smtpConfigured ? { provider: "smtp", configured: true, mode: "live", capabilities: ["transactional_email"], reason: "Configured; SMTP acceptance is not inbox delivery." } : unavailable("smtp", "Requires SMTP_ENABLED=true, SMTP_HOST/PORT/USER/PASSWORD/FROM (TLS port 465 or 587).");
  let transport = dependencies.mailTransport;
  const accountSid = env.TWILIO_ACCOUNT_SID || "";
  const token2 = env.TWILIO_AUTH_TOKEN || "";
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID || "";
  const from = env.TWILIO_FROM || "";
  const smsConfigured = env.SMS_ENABLED === "true" && /^AC[a-f0-9]{32}$/i.test(accountSid) && token2.length >= 20 && (/^MG[a-f0-9]{32}$/i.test(messagingServiceSid) || /^\+[1-9]\d{7,14}$/.test(from));
  const smsStatus = smsConfigured ? { provider: "twilio", configured: true, mode: "live", capabilities: ["transactional_sms"], reason: "Configured; sender approval, destination permissions and delivery must be verified." } : unavailable("twilio", "Requires SMS_ENABLED=true, TWILIO_ACCOUNT_SID/AUTH_TOKEN and MESSAGING_SERVICE_SID or FROM.");
  const adapters = {
    email: {
      status: smtpStatus,
      async send(input) {
        if (!smtpConfigured) throw new IntegrationError("not_configured", smtpStatus.reason);
        validateEmail(input);
        transport ??= nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: smtpPort,
          secure: smtpPort === 465,
          requireTLS: true,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
          tls: { rejectUnauthorized: true },
          connectionTimeout: 15e3,
          greetingTimeout: 15e3,
          socketTimeout: 2e4,
          disableFileAccess: true,
          disableUrlAccess: true
        });
        const messageId = `<${createHash3("sha256").update(input.idempotencyKey).digest("hex")}@${smtpFrom.split("@")[1]}>`;
        let response;
        try {
          response = await transport.sendMail({ from: smtpFrom, to: input.to, subject: input.subject, text: input.text, messageId, disableFileAccess: true, disableUrlAccess: true });
        } catch {
          throw new IntegrationError("unknown_outcome", "Email outcome unknown; check the outbox/provider before resending.");
        }
        if (!response.accepted?.length || response.rejected?.length || !response.messageId) throw new IntegrationError("provider_rejected", "SMTP server did not accept the recipient.");
        return { provider: "smtp", messageId: response.messageId, status: "accepted" };
      }
    },
    sms: {
      status: smsStatus,
      async send(input) {
        if (!smsConfigured) throw new IntegrationError("not_configured", smsStatus.reason);
        assertReference(input.idempotencyKey, "notification idempotency key");
        if (!/^\+[1-9]\d{7,14}$/.test(input.to) || typeof input.text !== "string" || input.text.length < 1 || input.text.length > 1600) throw new IntegrationError("invalid_request", "Invalid SMS notification.");
        const form = new URLSearchParams({ To: input.to, Body: input.text });
        form.set(messagingServiceSid ? "MessagingServiceSid" : "From", messagingServiceSid || from);
        let response;
        try {
          response = await (dependencies.fetcher || fetch)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(2e4),
            headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${token2}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString()
          });
        } catch {
          throw new IntegrationError("unknown_outcome", "SMS outcome unknown; check the outbox/provider before resending.");
        }
        if (!response.ok) throw new IntegrationError(response.status >= 500 ? "unknown_outcome" : "provider_rejected", "SMS provider did not accept the message.");
        const data = object3(await response.json().catch(() => null));
        if (typeof data.sid !== "string" || !/^SM[a-f0-9]{32}$/i.test(data.sid) || !["accepted", "queued", "sending", "sent", "delivered"].includes(String(data.status))) throw new IntegrationError("unknown_outcome", "SMS response could not be reconciled.");
        return { provider: "twilio", messageId: data.sid, status: "accepted" };
      }
    }
  };
  const emailProvider = env.EMAIL_PROVIDER || (env.SMTP_ENABLED === "true" ? "smtp" : "resend");
  if (emailProvider === "resend") adapters.email = createResendEmailAdapter(env, dependencies.fetcher);
  else if (emailProvider !== "smtp") adapters.email = { status: unavailable("email", "Unknown EMAIL_PROVIDER. Choose resend or smtp."), async send() {
    throw new IntegrationError("not_configured", "Unknown email provider.");
  } };
  return adapters;
}

// server/integrations/outbox.ts
async function dispatchNotificationOutbox(store, adapters, options) {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit || 10)));
  const rows = await store.claimBatch({ limit, workerId: options.workerId, now: options.now || (/* @__PURE__ */ new Date()).toISOString() });
  const results = [];
  for (const row2 of rows) {
    let outcome;
    try {
      let receipt;
      if (row2.channel === "email") receipt = await adapters.email.send({ idempotencyKey: row2.idempotencyKey, to: row2.to, subject: row2.subject || "", text: row2.text });
      else if (row2.channel === "sms") receipt = await adapters.sms.send({ idempotencyKey: row2.idempotencyKey, to: row2.to, text: row2.text });
      else throw new IntegrationError("invalid_request", "Invalid notification channel.");
      outcome = { state: "accepted", provider: receipt.provider, messageId: receipt.messageId };
    } catch (error2) {
      const code = error2 instanceof IntegrationError ? error2.code : "unknown_outcome";
      outcome = { state: code === "not_configured" ? "blocked" : ["provider_rejected", "invalid_request"].includes(code) ? "rejected" : "unknown", errorCode: code };
    }
    await store.finish(row2.id, outcome);
    results.push({ id: row2.id, outcome });
  }
  return results;
}

// server/index.ts
function unavailablePlatform(req, res) {
  if (!(req.url || "").startsWith("/api/platform/"))
    return Promise.resolve(false);
  const origins = new Set(
    (process.env.ALLOWED_APP_ORIGINS || process.env.PUBLIC_ORIGIN || "").split(",").map((value) => value.trim())
  );
  const origin = req.headers.origin;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
  if (origin && origins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,X-CNBUY-Request,X-CSRF-Token,Idempotency-Key"
    );
    res.writeHead(204);
    res.end();
    return Promise.resolve(true);
  }
  res.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(
    JSON.stringify({
      error: {
        code: "PERSISTENCE_NOT_CONFIGURED",
        message: "\u5E33\u6236\u8207\u8A02\u55AE\u670D\u52D9\u5C1A\u672A\u5B8C\u6210\u8CC7\u6599\u5EAB\u914D\u7F6E\uFF0C\u672A\u5EFA\u7ACB\u4EFB\u4F55\u4EA4\u6613\u3002"
      }
    })
  );
  return Promise.resolve(true);
}
async function startServer() {
  const config = configFromEnv();
  const catalog = createCatalogService(config);
  let database;
  let notificationTimer;
  let handler = unavailablePlatform;
  try {
    database = await databaseFromEnv();
    const platform = platformConfigFromEnv();
    const notifications = createNotificationAdapters();
    handler = createPlatformHandler({
      database,
      config: platform,
      publicOrigin: platform.publicOrigin,
      catalog: config.apiKey ? { getProduct: async (id2) => (await catalog.detail(id2, true)).product } : void 0,
      payment: createPaymentAdapter(),
      notifications,
      procurement: createProcurementServiceFromEnv(database)
    });
    if (process.env.NOTIFICATIONS_ENABLED === "true") {
      const store = createOutboxStore(database);
      let working = false;
      const dispatch = async () => {
        if (working) return;
        working = true;
        try {
          await dispatchNotificationOutbox(store, notifications, {
            workerId: `web-${process.pid}`,
            limit: 10
          });
        } catch {
          console.error(
            "Notification queue dispatch failed; entries remain durable for operator review."
          );
        } finally {
          working = false;
        }
      };
      notificationTimer = setInterval(() => {
        void dispatch();
      }, 2e4);
      notificationTimer.unref();
    }
    console.log(`CNBUY platform persistence ready (${database.dialect}).`);
  } catch {
    await database?.close().catch(() => {
    });
    database = void 0;
    console.error(
      "CNBUY platform disabled: database or deployment configuration is unavailable. Catalog remains online."
    );
  }
  const server = createApiServer(config, {
    catalogService: catalog,
    platformHandler: async (req, res) => {
      if (req.url === "/health/platform" && req.method === "GET") {
        let ready = false;
        try {
          if (database) {
            await database.all("SELECT 1");
            ready = true;
          }
        } catch {
        }
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ready, service: "cnbuy-platform", version: "0.6.0" }));
        return true;
      }
      return handler(req, res);
    }
  });
  server.listen(
    config.port,
    "0.0.0.0",
    () => console.log(`CNBUY API listening on port ${config.port}.`)
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    clearInterval(notificationTimer);
    server.close(() => {
      if (database) void database.close().finally(() => process.exit(0));
      else process.exit(0);
    });
    setTimeout(() => process.exit(0), 5e3).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, close);
  return { server, database };
}
if (process.argv[1] && resolve2(process.argv[1]) === fileURLToPath(import.meta.url))
  void startServer();
export {
  startServer
};
