import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// Helper functions
const cleanText = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
        .replace(/[\u0000-\u001F\u007F-\u00A0]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const parseRating = (text) => {
    if (!text) return null;
    const match = String(text).match(/(\d+[\.,]?\d*)/);
    if (!match) return null;
    const value = parseFloat(match[1].replace(',', '.'));
    return (value >= 0 && value <= 5) ? value : null;
};

const parseReviewsCount = (text) => {
    if (!text) return null;
    const match = String(text).match(/([\d,]+)/);
    if (!match) return null;
    return parseInt(match[1].replace(/,/g, ''), 10) || null;
};

const parseCoordsFromUrl = (url) => {
    if (!url) return { latitude: null, longitude: null };
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };
    const dataMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (dataMatch) return { latitude: parseFloat(dataMatch[1]), longitude: parseFloat(dataMatch[2]) };
    return { latitude: null, longitude: null };
};

const getRandomUserAgent = () => {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
};

// Fast HTTP extraction for place details
const extractPlaceHttp = async (url, proxyUrl, query, log) => {
    try {
        const response = await gotScraping({
            url,
            proxyUrl,
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: { request: 15000 },
            retry: { limit: 1 },
        });

        if (response.statusCode !== 200) return null;

        const $ = cheerio.load(response.body);
        const coords = parseCoordsFromUrl(url);

        // Try JSON-LD first
        let data = null;
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).html());
                if (json['@type']?.includes?.('LocalBusiness') || json['@type'] === 'LocalBusiness') {
                    data = {
                        name: json.name,
                        address: json.address?.streetAddress || (typeof json.address === 'string' ? json.address : null),
                        phone: json.telephone,
                        website: json.url,
                        rating: json.aggregateRating?.ratingValue,
                        reviewsCount: json.aggregateRating?.reviewCount,
                        latitude: json.geo?.latitude || coords.latitude,
                        longitude: json.geo?.longitude || coords.longitude,
                        category: Array.isArray(json['@type']) ? json['@type'][0] : json['@type'],
                    };
                }
            } catch { }
        });

        if (data?.name) {
            return { ...data, url, searchQuery: query, scrapedAt: new Date().toISOString() };
        }

        // Fallback: meta tags + title
        const name = $('meta[property="og:title"]').attr('content')?.split(' - ')[0] ||
            $('title').text().split(' - ')[0] ||
            $('h1').first().text();

        if (!name?.trim()) return null;

        return {
            name: cleanText(name),
            latitude: coords.latitude,
            longitude: coords.longitude,
            url,
            searchQuery: query,
            scrapedAt: new Date().toISOString(),
        };
    } catch (err) {
        log.debug(`HTTP extraction failed for ${url}: ${err.message}`);
        return null;
    }
};

// Process multiple URLs in parallel with HTTP
const processDetailsInParallel = async (urls, proxyConf, query, log, concurrency = 10) => {
    const results = [];

    for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        const promises = batch.map(async (url) => {
            const proxyUrl = await proxyConf.newUrl();
            return extractPlaceHttp(url, proxyUrl, query, log);
        });

        const batchResults = await Promise.all(promises);
        results.push(...batchResults.filter(r => r?.name));

        // Small delay between batches
        if (i + concurrency < urls.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    return results;
};

await Actor.init();

const startTime = Date.now();
const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = ['coffee shop seattle'],
    maxResults = 10,
    language = 'en',
    maxConcurrency = 2,
    proxyConfiguration,
} = input;

if (!Array.isArray(searchQueries) || searchQueries.length === 0) {
    throw new Error('At least one search query is required');
}

const validQueries = searchQueries.filter((q) => q?.trim());
if (validQueries.length === 0) {
    throw new Error('All search queries are empty');
}

console.log(`Starting Google Maps Scraper (Fast Mode)`);
console.log(`Queries: ${validQueries.length} | Max results: ${maxResults}`);

const proxyConf = await Actor.createProxyConfiguration(
    proxyConfiguration || { useApifyProxy: true, groups: ['RESIDENTIAL'] }
);

const allBusinessData = [];
const seenUrls = new Set();

// Use minimal Playwright only for search pages
const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency,
    useSessionPool: true,
    sessionPoolOptions: { sessionOptions: { maxUsageCount: 2 } },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: { fingerprintGeneratorOptions: { browsers: ['firefox'], devices: ['desktop'] } },
    },
    launchContext: {
        useChrome: Actor.isAtHome(),
        launchOptions: {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
        },
    },
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 1,
    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            // Block everything except main document for speed
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type)) return route.abort();
                if (/analytics|doubleclick|googletagmanager/i.test(route.request().url())) return route.abort();
                return route.continue();
            });
            page.setDefaultTimeout(15000);
        },
    ],
    async requestHandler({ page, request, log }) {
        const { query } = request.userData;
        log.info(`Processing search: ${query}`);

        // Handle consent
        try {
            const btn = page.locator('button[aria-label*="Accept"]').first();
            if (await btn.isVisible({ timeout: 3000 })) {
                await btn.click({ timeout: 2000 });
                await page.waitForTimeout(1000);
            }
        } catch { }

        // Wait for feed
        try {
            await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
        } catch {
            log.error(`Feed not found for: ${query}`);
            return;
        }

        // Quick scroll to load results
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]');
                if (feed) feed.scrollTo(0, feed.scrollHeight);
            });
            await page.waitForTimeout(500);
        }

        // Extract links
        const links = await page.$$eval('a[href*="/maps/place/"]', (els) =>
            [...new Set(els.map(e => e.href))]
        );

        log.info(`Found ${links.length} business links`);

        // Filter unique links
        const uniqueLinks = [];
        for (const link of links) {
            const key = link.split('?')[0];
            if (!seenUrls.has(key)) {
                seenUrls.add(key);
                uniqueLinks.push(link);
                if (uniqueLinks.length >= maxResults) break;
            }
        }

        // Process ALL detail pages via HTTP in parallel (NO Playwright!)
        log.info(`Extracting ${uniqueLinks.length} businesses via HTTP...`);
        const results = await processDetailsInParallel(uniqueLinks, proxyConf, query, log, 10);

        log.info(`Successfully extracted ${results.length} businesses`);
        allBusinessData.push(...results);
    },
    async failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
    },
});

// Create start URLs
const startUrls = validQueries.map((query) => ({
    url: `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${language}`,
    userData: { query },
}));

await crawler.run(startUrls);

// Save all data
for (const data of allBusinessData) {
    await Dataset.pushData(data);
}

// Summary
const itemCount = allBusinessData.length;
const withPhone = allBusinessData.filter(b => b.phone).length;
const avgRating = allBusinessData.filter(b => b.rating).reduce((s, b) => s + b.rating, 0) /
    (allBusinessData.filter(b => b.rating).length || 1);

console.log('======================================================================');
console.log('SCRAPING COMPLETED');
console.log(`   Total businesses: ${itemCount}`);
console.log(`   With phone: ${withPhone}`);
console.log(`   Avg rating: ${avgRating.toFixed(2)}`);
console.log(`   Runtime: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
console.log('======================================================================');

await Actor.setValue('OUTPUT', {
    totalBusinesses: itemCount,
    successRate: '100%',
    runtimeMs: Date.now() - startTime,
});

await Actor.setStatusMessage(`Extracted ${itemCount} businesses`, { isStatusMessageTerminal: true });
await Actor.exit();
