# Google Maps Business Scraper

Extract local business profiles from Google Maps using a stealthy Playwright crawler. Ideal for lead generation, market research, and local SEO with optional review and image capture.

## What this actor does

- Launches Playwright with fingerprints and proxies to reduce blocking on Google Maps.
- Scrolls local results, enqueues place pages, and extracts names, ratings, reviews, contacts, coordinates, and optional images.
- Cleans text (strips emojis/special chars) and normalizes hours to keep outputs consistent.
- Provides run statistics and status messages for Apify monitoring.

## Quick start

Minimal cardiologist search:

```json
{
  "searchQueries": ["cardiologist"],
  "maxResults": 20
}
```

City-focused with images and reviews:

```json
{
  "searchQueries": ["coffee shop seattle"],
  "maxResults": 40,
  "includeReviews": true,
  "includeImages": true
}
```

Budget-friendly fast run:

```json
{
  "searchQueries": ["plumber austin"],
  "maxResults": 10,
  "includeReviews": false,
  "includeImages": false
}
```

## Input parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| `searchQueries` | array<string> | Required list of search terms (e.g., `"cardiologist"`, `"coffee shop seattle"`). |
| `maxResults` | integer | Maximum businesses per query (1-500). |
| `includeReviews` | boolean | Capture up to 10 review snippets when available. |
| `includeImages` | boolean | Save up to 5 image URLs per place. |
| `language` | string | Interface language code (e.g., `en`, `fr`). |
| `maxConcurrency` | integer | Parallel pages; tune for speed vs. blocking risk. |
| `proxyConfiguration` | object | Proxy settings; Apify residential proxy recommended. |

## Output

Each dataset item includes:

```json
{
  "name": "City Heart Clinic",
  "category": "Cardiologist",
  "rating": 4.8,
  "reviewsCount": 152,
  "address": "123 Main St, Anytown, TX 78701",
  "phone": "+1 512-555-0100",
  "website": "https://cityheartclinic.example",
  "url": "https://www.google.com/maps/place/...",
  "latitude": 30.2672,
  "longitude": -97.7431,
  "hours": "Open ⋅ Closes 6 PM",
  "images": ["https://.../image1.jpg"],
  "reviews": ["Great service", "Kind staff"],
  "searchQuery": "cardiologist",
  "scrapedAt": "2025-01-19T10:00:00.000Z"
}
```

## How it works

1) Launches Playwright with fingerprints, Chrome, and proxy support for stealthy navigation.
2) Loads Google Maps search, scrolls the results feed, and collects place links up to `maxResults` per query.
3) Visits each place page, extracting primary data; optionally clicks reviews and collects image URLs.
4) Cleans text, normalizes hours, and stores results in the default dataset with run summaries.

## Recommended settings

- Lead lists: `maxResults: 100`, `includeReviews: true`, `includeImages: true`, residential proxy.
- Fast checks: `maxResults: 20`, `includeReviews: false`, `includeImages: false`.
- High reliability: keep `maxConcurrency` modest (3-5) with residential proxies.

## Best practices

- Start small to verify proxy health and selector stability.
- Prefer residential proxies for sticky sessions and reduced blocks.
- Keep queries specific (city + vertical) to reduce duplicates.
- Avoid excessive concurrency; balance speed against Google rate limits.

## Troubleshooting

- Empty dataset: verify queries, reduce concurrency, and ensure proxy access to Google.
- Missing phones/websites: enable `includeReviews` and keep `includeImages` if you need richer place pages; some places simply do not publish contact info.
- Slow runs: lower `maxResults` or disable reviews/images to cut page work.

## SEO & discoverability

Google Maps scraper, local business data, Playwright crawler, lead generation, local SEO insights, business contact extraction, Google Maps reviews, location intelligence, place data enrichment.

---

Built to match Apify QA expectations: clear inputs, proxy support, fingerprinted Playwright, resilient selectors, and documented fallbacks.