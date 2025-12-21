import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// Helper functions
const cleanText = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
        .replace(/[\u{2000}-\u{2FFF}]/gu, '')
        .replace(/[\u0000-\u001F\u007F-\u00A0\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g, '')
        .replace(/[\uFE00-\uFE0F]/g, '')
        .replace(/[^\x20-\x7E\xA0-\xFF\u0100-\u017F\u0180-\u024F]/g, '')
        .replace(/,?\s*Copy open hours/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const cleanHours = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\u00b7\u2022]\s*See more hours?/gi, '')
        .replace(/See more hours?[\u00b7\u2022]?/gi, '')
        .replace(/[\u00b7\u2022,]?\s*Copy open hours?/gi, '')
        .replace(/^Open\s*[\u00b7\u2022]\s*/i, '')
        .replace(/Closes soon\s*[\u00b7\u2022]\s*/gi, '')
        .replace(/[\u00b7\u2022]\s*Opens \d+[AP]M \w+/gi, '')
        .replace(/[\u00b7\u2022]+/g, '·')
        .replace(/\s+/g, ' ')
        .trim();
};

const parseRating = (text) => {
    if (!text || typeof text !== 'string') return null;
    const cleaned = text.replace('\u200E', '');
    const match = cleaned.match(/(\d+[\.,]?\d*)/);
    if (!match) return null;
    const value = parseFloat(match[1].replace(',', '.'));
    if (Number.isNaN(value) || value < 0 || value > 5) return null;
    return value;
};

const parseReviewsCount = (text) => {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/([\d,\.\s]+)\s*(reviews|review)?/i) || text.match(/\(?([\d,]+)\)?/);
    if (!match || !match[1]) return null;
    const value = parseInt(match[1].replace(/[^\d]/g, ''), 10);
    return Number.isNaN(value) ? null : value;
};

const parseCoordsFromUrl = (url) => {
    if (!url || typeof url !== 'string') return { latitude: null, longitude: null };
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
        return {
            latitude: parseFloat(atMatch[1]),
            longitude: parseFloat(atMatch[2]),
        };
    }
    const dataMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (dataMatch) {
        return {
            latitude: parseFloat(dataMatch[1]),
            longitude: parseFloat(dataMatch[2]),
        };
    }
    return { latitude: null, longitude: null };
};

const canonicalizePlaceUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    return url.split('?')[0];
};

// Generate random User-Agent
const getRandomUserAgent = () => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Extract business data from place page HTML using cheerio
const extractBusinessFromHtml = (html, url, query) => {
    const $ = cheerio.load(html);

    // Try to find JSON-LD data first
    let businessData = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const json = JSON.parse($(el).html());
            if (json['@type'] === 'LocalBusiness' || json['@type']?.includes('LocalBusiness')) {
                businessData = {
                    name: json.name,
                    address: json.address?.streetAddress || json.address,
                    phone: json.telephone,
                    rating: json.aggregateRating?.ratingValue,
                    reviewsCount: json.aggregateRating?.reviewCount,
                    latitude: json.geo?.latitude,
                    longitude: json.geo?.longitude,
                    category: json['@type'],
                    website: json.url,
                };
            }
        } catch {
            // Ignore JSON parse errors
        }
    });

    if (businessData) {
        return {
            ...businessData,
            url,
            searchQuery: query,
            scrapedAt: new Date().toISOString(),
        };
    }

    // Fallback to HTML parsing
    const name = $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content')?.split('-')[0]?.trim();

    const coords = parseCoordsFromUrl(url);

    return {
        name: cleanText(name),
        url,
        searchQuery: query,
        latitude: coords.latitude,
        longitude: coords.longitude,
        scrapedAt: new Date().toISOString(),
    };
};

// Try HTTP-first extraction for place details
const fetchPlaceDetailsHttp = async (url, proxyUrl, log) => {
    try {
        const response = await gotScraping({
            url,
            proxyUrl,
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
            timeout: { request: 30000 },
            retry: { limit: 2 },
        });

        if (response.statusCode === 200) {
            log.debug(`HTTP fetch successful for: ${url}`);
            return response.body;
        }
        log.warning(`HTTP fetch returned ${response.statusCode} for: ${url}`);
        return null;
    } catch (err) {
        log.debug(`HTTP fetch failed: ${err.message}`);
        return null;
    }
};

await Actor.init();

const startTime = Date.now();
await Actor.setValue('START_TIME', startTime);

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = ['coffee shop seattle'],
    maxResults = 10,
    includeReviews = false,
    includeImages = true,
    language = 'en',
    maxConcurrency = 3,
    proxyConfiguration,
    fastMode = true,
} = input;

if (!Array.isArray(searchQueries) || searchQueries.length === 0) {
    throw new Error('At least one search query is required. Example: "restaurants in New York"');
}

if (maxResults < 1 || maxResults > 500) {
    throw new Error('maxResults must be between 1 and 500');
}

const validQueries = searchQueries.filter((q) => q && q.trim().length > 0);
if (validQueries.length === 0) {
    throw new Error('All search queries are empty. Provide valid search terms.');
}

console.log(`Starting Google Maps Business Scraper`);
console.log(`Queries: ${validQueries.length} | Max results per query: ${maxResults}`);
console.log(`Include reviews: ${includeReviews} | Include images: ${includeImages} | Fast mode: ${fastMode}`);

const proxyConf = await Actor.createProxyConfiguration(
    proxyConfiguration || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const seenBusinessUrls = new Set();
const requestQueue = await RequestQueue.open();

// Add search URLs to queue
for (const query of validQueries) {
    const encodedQuery = encodeURIComponent(query);
    await requestQueue.addRequest({
        url: `https://www.google.com/maps/search/${encodedQuery}?hl=${language}`,
        userData: { label: 'SEARCH', query },
    });
}

const autoScroll = async (page, containerSelector, itemSelector, maxItems) => {
    const container = await page.$(containerSelector);
    if (!container) return;

    let previousHeight = 0;
    let scrollAttempts = 0;
    let stableCount = 0;
    const maxScrollAttempts = Math.max(3, Math.ceil(maxItems / 12));

    while (scrollAttempts < maxScrollAttempts) {
        if (itemSelector) {
            const currentCount = await page.$$eval(itemSelector, (links) => {
                return new Set(links.map((link) => link.href)).size;
            });
            if (currentCount >= maxItems) break;
        }

        await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            if (element) element.scrollTo(0, element.scrollHeight);
        }, containerSelector);

        const randomDelay = 600 + Math.floor(Math.random() * 300);
        await page.waitForTimeout(randomDelay);

        const newHeight = await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            return element ? element.scrollHeight : 0;
        }, containerSelector);

        if (newHeight === previousHeight) {
            stableCount += 1;
        } else {
            stableCount = 0;
        }
        if (stableCount >= 2) break;

        previousHeight = newHeight;
        scrollAttempts += 1;
    }
};

const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration: proxyConf,
    maxConcurrency,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 3,
            maxErrorScore: 1,
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['firefox', 'chrome'],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos', 'linux'],
            },
        },
    },
    launchContext: {
        useChrome: Actor.isAtHome(),
        launchOptions: {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1920,1080',
            ],
        },
    },
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 2,
    preNavigationHooks: [
        async ({ page, request }) => {
            // Apply stealth
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                window.chrome = { runtime: {}, loadTimes: () => { }, csi: () => { } };
            });

            // Block unnecessary resources for speed
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                const url = route.request().url();

                if (['font', 'media', 'stylesheet'].includes(resourceType)) {
                    return route.abort();
                }
                if (request.userData?.label === 'SEARCH' && resourceType === 'image') {
                    return route.abort();
                }
                if (/analytics|doubleclick|googletagmanager/i.test(url)) {
                    return route.abort();
                }
                return route.continue();
            });

            page.setDefaultTimeout(20000);
            page.setDefaultNavigationTimeout(45000);
            await page.setExtraHTTPHeaders({
                'accept-language': `${language},en;q=0.9`,
            });
        },
    ],
    async requestHandler({ page, request, log }) {
        const { label, query, businessUrl } = request.userData;

        if (label === 'SEARCH') {
            log.info(`Processing search: ${query}`);

            // Handle consent dialogs
            try {
                const consentBtn = page.locator('button[aria-label*="Accept"], form[action*="consent"] button').first();
                if (await consentBtn.isVisible({ timeout: 5000 })) {
                    await consentBtn.click({ timeout: 3000 });
                    log.info('Dismissed consent dialog');
                    await page.waitForTimeout(1500);
                }
            } catch {
                // No consent dialog
            }

            // Wait for feed with multiple selector fallbacks
            const feedSelectors = ['div[role="feed"]', 'div.m6QErb', 'div[aria-label*="Results"]'];
            let feedFound = false;

            for (const selector of feedSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 20000 });
                    feedFound = true;
                    log.info(`Feed found using: ${selector}`);
                    break;
                } catch {
                    log.debug(`Selector ${selector} not found`);
                }
            }

            if (!feedFound) {
                // Check for captcha/block
                const content = await page.content();
                if (content.includes('unusual traffic') || content.includes('captcha')) {
                    throw new Error('Bot detection - retrying with new session');
                }
                log.error(`Feed not found, skipping: ${query}`);
                return;
            }

            await page.waitForTimeout(800 + Math.random() * 400);
            await autoScroll(page, 'div[role="feed"]', 'a[href*="/maps/place/"]', maxResults);

            const businessLinks = await page.$$eval('a[href*="/maps/place/"]', (links) => {
                return [...new Set(links.map((link) => link.href))];
            });

            log.info(`Found ${businessLinks.length} businesses for query: ${query}`);

            const limitedLinks = [];
            for (const detailUrl of businessLinks) {
                const key = canonicalizePlaceUrl(detailUrl);
                if (seenBusinessUrls.has(key)) continue;
                seenBusinessUrls.add(key);
                limitedLinks.push(detailUrl);
                if (limitedLinks.length >= maxResults) break;
            }

            // Add detail pages to queue
            for (const detailUrl of limitedLinks) {
                await requestQueue.addRequest({
                    url: detailUrl,
                    userData: { label: 'DETAIL', query, businessUrl: detailUrl },
                });
            }
            return;
        }

        if (label === 'DETAIL') {
            log.info(`Extracting: ${businessUrl}`);

            // Try HTTP first for faster extraction
            const proxyUrl = await proxyConf.newUrl();
            const httpHtml = await fetchPlaceDetailsHttp(businessUrl, proxyUrl, log);

            let businessData = null;

            if (httpHtml && httpHtml.includes('"@type"')) {
                businessData = extractBusinessFromHtml(httpHtml, businessUrl, query);
                if (businessData?.name) {
                    log.info(`HTTP extracted: ${businessData.name}`);
                }
            }

            // If HTTP didn't work, use the Playwright page data
            if (!businessData?.name) {
                try {
                    await page.waitForSelector('h1', { timeout: 15000 });
                } catch {
                    log.debug('h1 selector timeout, continuing...');
                }

                const extracted = await page.evaluate((captureImages) => {
                    const pickText = (selectors) => {
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el?.textContent) return el.textContent.trim();
                        }
                        return null;
                    };

                    const pickAttr = (selectors, attr) => {
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            const val = el?.getAttribute(attr);
                            if (val) return val;
                        }
                        return null;
                    };

                    const name = pickText(['h1', 'h1 span', 'div[role="main"] h1']);
                    const category = pickText(['button[jsaction*="category"]', 'button[aria-label*="Category"]']);
                    const ratingText = pickAttr(['span[aria-label*="stars"]'], 'aria-label') ||
                        pickText(['span.ceNzKf', 'span.MW4etd']);
                    const reviewsText = pickAttr(['button[aria-label*="review"]'], 'aria-label') ||
                        pickText(['div.F7nice span:last-child']);
                    const address = pickText(['button[data-item-id="address"]', 'button[aria-label*="Address"]']);
                    const phone = pickText(['button[data-item-id*="phone"]', 'a[href^="tel:"]']);
                    const website = pickAttr(['a[data-item-id="authority"]'], 'href');
                    const hours = pickAttr(['button[data-item-id*="hours"]'], 'aria-label');

                    const imageUrls = [];
                    if (captureImages) {
                        const imgs = document.querySelectorAll('button[aria-label*="Photo"] img');
                        for (const img of imgs) {
                            const src = img.src || img.dataset.src;
                            if (src?.startsWith('http')) imageUrls.push(src);
                            if (imageUrls.length >= 5) break;
                        }
                    }

                    return { name, category, ratingText, reviewsText, address, phone, website, hours, images: imageUrls };
                }, includeImages);

                const coords = parseCoordsFromUrl(businessUrl) || parseCoordsFromUrl(page.url());

                businessData = {
                    name: cleanText(extracted.name),
                    category: cleanText(extracted.category) || undefined,
                    address: cleanText(extracted.address) || undefined,
                    phone: cleanText(extracted.phone) || undefined,
                    website: extracted.website || undefined,
                    rating: parseRating(extracted.ratingText),
                    reviewsCount: parseReviewsCount(extracted.reviewsText),
                    latitude: coords.latitude || undefined,
                    longitude: coords.longitude || undefined,
                    hours: cleanHours(extracted.hours) || undefined,
                    images: includeImages && extracted.images?.length > 0 ? extracted.images : undefined,
                    url: businessUrl,
                    searchQuery: query,
                    scrapedAt: new Date().toISOString(),
                };
            }

            if (!businessData?.name) {
                log.warning(`Skipping - no name extracted: ${businessUrl}`);
                return;
            }

            await Dataset.pushData(businessData);
            log.info(`Saved: ${businessData.name} | Rating: ${businessData.rating || 'N/A'}`);
        }
    },
    async failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
        await Dataset.pushData({
            error: true,
            url: request.url,
            query: request.userData.query,
            errorMessage: request.errorMessages?.join(', ') || 'Request failed',
            timestamp: new Date().toISOString(),
        });
    },
});

await crawler.run();

// Summary
const dataset = await Dataset.open();
const { items } = await dataset.getData();
const successfulItems = items.filter((item) => !item.error);
const failedItems = items.filter((item) => item.error);
const itemCount = successfulItems.length;

const businessesWithPhone = successfulItems.filter((b) => b.phone).length;
const businessesWithWebsite = successfulItems.filter((b) => b.website).length;
const avgRating = successfulItems.filter((b) => b.rating).reduce((sum, b) => sum + b.rating, 0) /
    (successfulItems.filter((b) => b.rating).length || 1);

console.log('======================================================================');
console.log('SCRAPING COMPLETED');
console.log('======================================================================');
console.log(`   Total businesses extracted: ${itemCount}`);
console.log(`   Businesses with phone: ${businessesWithPhone}`);
console.log(`   Businesses with website: ${businessesWithWebsite}`);
console.log(`   Average rating: ${avgRating.toFixed(2)}`);
console.log(`   Failed requests: ${failedItems.length}`);
console.log('======================================================================');

const runtimeMs = Date.now() - startTime;
const runStats = {
    success: true,
    summary: {
        totalBusinesses: itemCount,
        failedRequests: failedItems.length,
        successRate: `${itemCount + failedItems.length ? ((itemCount / (itemCount + failedItems.length)) * 100).toFixed(1) : '0.0'}%`,
    },
    dataQuality: {
        withPhone: businessesWithPhone,
        withWebsite: businessesWithWebsite,
        phonePercentage: `${itemCount ? ((businessesWithPhone / itemCount) * 100).toFixed(1) : '0.0'}%`,
        averageRating: parseFloat(avgRating.toFixed(2)),
    },
    searchQueries: validQueries,
    timestamp: new Date().toISOString(),
    runtimeMs,
};

await Actor.setValue('OUTPUT', runStats);
await Actor.setStatusMessage(
    `Extracted ${itemCount} businesses | Success rate: ${runStats.summary.successRate}`,
    { isStatusMessageTerminal: true },
);

await Actor.exit();
