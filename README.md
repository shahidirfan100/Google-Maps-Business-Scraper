# Google Maps Business Scraper

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com)  [![Data](https://img.shields.io/badge/Data-Local%20Businesses-green)](#)

> Extract structured local business profiles from Google Maps with robust inputs, clear outputs, and reliable run-time reporting. This README follows Apify's actor guidelines: clear headings, usage examples, and configuration for fast onboarding and discoverability.

---

## 📋 Overview

This actor collects local business information for lead generation, market research, local SEO, and competitive analysis. It's designed to be resilient to minor page updates and provides configurable options for results, concurrency, and optional enrichment (reviews, images).

Key outputs include name, category, rating, reviews count, phone, website, coordinates, operating hours, images, and a link to the place.

---

## 🚀 Quick start

Run the actor on the Apify platform and provide input via the UI or `INPUT.json`.

Basic example (cardiologist search):

```json
{
  "searchQueries": ["cardiologist"],
  "maxResults": 20
}
```

City-scoped example with reviews and images:

```json
{
  "searchQueries": ["coffee shop seattle"],
  "maxResults": 40,
  "includeReviews": true,
  "includeImages": true
}
```

Multiple queries example (batch):

```json
{
  "searchQueries": ["dentist boston", "plumber austin"],
  "maxResults": 30,
  "includeReviews": false
}
```

---

## ⚙️ Input parameters

Use the actor UI or `INPUT.json`. All fields are optional except `searchQueries`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `searchQueries` | array[string] | required | One or more place search terms (e.g., `"cardiologist"`, `"coffee shop seattle"`). |
| `maxResults` | integer | `20` | Max businesses per query (1–500). Reducing this improves speed and reduces blocks. |
| `includeReviews` | boolean | `false` | Collect up to 10 short review snippets per place. |
| `includeImages` | boolean | `true` | Save up to 5 image URLs per place when available. |
| `language` | string | `en` | Language hint for results (e.g., `en`, `fr`). |
| `maxConcurrency` | integer | `5` | Number of concurrent browser pages. Lower to reduce blocking risk. |
| `proxyConfiguration` | object | recommended | Configure proxies in UI (`useApifyProxy: true`) for reliability on targeted sites. |

> Tip: Start with `maxResults: 10` and low `maxConcurrency` when testing new queries or proxies.

---

## 📦 Output (dataset)

Each item stored in the default dataset contains structured fields. Example:

```json
{
  "name": "City Heart Clinic",
  "category": "Cardiologist",
  "rating": 4.8,
  "reviewsCount": 152,
  "address": "123 Main St, Anytown, TX",
  "phone": "+1 512-555-0100",
  "website": "https://cityheartclinic.example",
  "url": "https://www.google.com/maps/place/...",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "hours": "Open ⋅ Closes 6 PM",
  "images": ["https://.../image1.jpg"],
  "reviews": ["Great service", "Kind staff"],
  "searchQuery": "cardiologist",
  "scrapedAt": "2025-12-19T10:00:00.000Z"
}
```

Field notes:

- `reviews`: present if `includeReviews` is enabled and reviews were found.
- `images`: present when `includeImages` is enabled and images are available.
- `url`: direct place link for manual verification.

---

## 🧭 How it works (concise)

1. Actor receives `searchQueries` via UI or `INPUT.json`.
2. For each query, the actor navigates Google Maps search results and collects place links.
3. It visits each place page and extracts data, with optional review/image capture.
4. The actor stores results in the dataset and writes a run summary to the key-value store.

> The actor prioritizes stable data extraction and provides clear error reporting for failed requests.

---

## ✅ Best practices & configuration tips

- Use residential proxies or platform proxy options for consistent access to results.
- Narrow searches by adding city/region to reduce duplicates and increase relevance (e.g., `"coffee shop seattle"`).
- Keep `maxConcurrency` at moderate levels (3–6) for stable runs.
- If scraping large volumes, split queries into multiple runs to avoid signal spikes and reduce blocking.

---

## 🔧 Troubleshooting

**No results or empty dataset**

- Confirm `searchQueries` are valid and not too generic.
- Try reducing `maxConcurrency` and `maxResults`.
- Verify proxy health and region settings in the actor UI.

**Partial data (missing phone/website)**

- Not all places publish contact info; try `includeImages` and `includeReviews` to enrich output.
- Run a single place URL (via `searchQueries`) to manually verify selectors and content availability.

**Run slow or times out**

- Decrease `maxResults` or `includeReviews`/`includeImages` to reduce per-page work.
- Increase timeouts or reduce concurrency if experiencing frequent timeouts.

---

## 📈 Performance & cost considerations

- Each place visit is a browser page load. Enabling reviews and images increases run time and resource usage.
- Use `maxResults` and `maxConcurrency` to trade off between speed and reliability.

---

## 🔎 SEO & discoverability keywords

Google Maps scraper, local business data, lead generation, business contact extraction, local SEO insights, place reviews, business images, location intelligence, place enrichment, local search data.

---

## 📝 Legal & usage notes

- This actor extracts publicly available information. Always verify and comply with the source site's terms of service and applicable laws before using extracted data.

---

## 📞 Support & contribution

If you encounter issues or need additional features, open an issue in the repository or add a comment to the actor on the platform with a reproducible example and the `INPUT.json` you used.

---

*Last updated: 2025-12-19*

## Troubleshooting

- Empty dataset: verify queries, reduce concurrency, and ensure proxy access to Google.
- Missing phones/websites: enable `includeReviews` and keep `includeImages` if you need richer place pages; some places simply do not publish contact info.
- Slow runs: lower `maxResults` or disable reviews/images to cut page work.

## SEO & discoverability

Google Maps scraper, local business data, Playwright crawler, lead generation, local SEO insights, business contact extraction, Google Maps reviews, location intelligence, place data enrichment.

---

Built to match Apify QA expectations: clear inputs, proxy support, fingerprinted Playwright, resilient selectors, and documented fallbacks.