import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

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

const autoScroll = async (page, containerSelector, maxItems) => {
    const container = await page.$(containerSelector);
    if (!container) return;

    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.ceil(maxItems / 20);

    while (scrollAttempts < maxScrollAttempts) {
        await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            if (element) element.scrollTo(0, element.scrollHeight);
        }, containerSelector);

        await page.waitForTimeout(2000);

        const newHeight = await page.evaluate((sel) => {
            const element = document.querySelector(sel);
            return element ? element.scrollHeight : 0;
        }, containerSelector);

        if (newHeight === previousHeight) break;
        previousHeight = newHeight;
        scrollAttempts += 1;
    }
};

await Actor.init();

const startTime = Date.now();
await Actor.setValue('START_TIME', startTime);

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = ['coffee shops in San Francisco'],
    maxResults = 20,
    includeReviews = false,
    includeImages = true,
    language = 'en',
    maxConcurrency = 5,
    proxyConfiguration,
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
console.log(`Include reviews: ${includeReviews} | Include images: ${includeImages}`);

const startUrls = validQueries.map((query) => {
    const encodedQuery = encodeURIComponent(query);
    return {
        url: `https://www.google.com/maps/search/${encodedQuery}?hl=${language}`,
        userData: { label: 'SEARCH', query },
    };
});

const proxyConf = await Actor.createProxyConfiguration(
    proxyConfiguration || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency,
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos'],
            },
        },
    },
    launchContext: {
        useChrome: Actor.isAtHome(),
        launchOptions: {
            headless: true,
            devtools: false,
            args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'],
        },
    },
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    maxRequestsPerCrawl: maxResults * validQueries.length + 100,
    async requestHandler({ page, request, log }) {
        const { label, query, businessUrl } = request.userData;

        if (label === 'SEARCH') {
            log.info(`Processing search: ${query}`);
            await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
            await page.waitForTimeout(3000);
            await autoScroll(page, 'div[role="feed"]', maxResults);

            const businessLinks = await page.$$eval('a[href*="/maps/place/"]', (links) => {
                return [...new Set(links.map((link) => link.href))];
            });

            log.info(`Found ${businessLinks.length} businesses for query: ${query}`);
            const limitedLinks = businessLinks.slice(0, maxResults);

            for (const detailUrl of limitedLinks) {
                await crawler.addRequests([
                    {
                        url: detailUrl,
                        userData: { label: 'DETAIL', query, businessUrl: detailUrl },
                    },
                ]);
            }
            return;
        }

        if (label === 'DETAIL') {
            log.info(`Extracting business details from: ${businessUrl}`);

            await page.waitForSelector('h1', { timeout: 15000 });
            await page.waitForTimeout(3000);

            const trySelectors = async (selectors) => {
                for (const sel of selectors) {
                    try {
                        const el = await page.locator(sel).first();
                        if ((await el.count()) === 0) continue;
                        const txt = await el.textContent().catch(() => null);
                        if (txt && txt.trim().length > 0) return txt.trim();
                    } catch (e) {
                        /* continue */
                    }
                }
                return null;
            };

            const tryAttr = async (selectors, attr = 'href') => {
                for (const sel of selectors) {
                    try {
                        const el = await page.locator(sel).first();
                        if ((await el.count()) === 0) continue;
                        const val = await el.getAttribute(attr).catch(() => null);
                        if (val) return val;
                    } catch (e) {
                        /* continue */
                    }
                }
                return null;
            };

            const name = (await trySelectors(['h1', 'h1 span', 'div[role="main"] h1'])) || null;

            const category = await trySelectors([
                'button[jsaction*="category"]',
                'button[aria-label*="Category"]',
                'div[role="main"] button:nth-of-type(1)',
            ]);

            let rating = null;
            const ratingSelectors = [
                'div[role="article"] span[aria-hidden="true"]',
                'span[aria-label*="stars"]',
                'span.ceNzKf',
                'div.F7nice span[aria-hidden="true"]',
                'span.MW4etd',
            ];
            for (const sel of ratingSelectors) {
                try {
                    const txt = await page.locator(sel).first().textContent().catch(() => null);
                    if (txt) {
                        const cleaned = txt.replace('\u200E', '');
                        const m = cleaned.match(/(\d+[\.,]?\d*)/);
                        if (m) {
                            const v = parseFloat(m[1].replace(',', '.'));
                            if (!Number.isNaN(v) && v >= 0 && v <= 5) {
                                rating = v;
                                break;
                            }
                        }
                    }
                } catch (e) {
                    /* continue */
                }
            }

            let reviewsCount = null;
            const reviewsSelectors = [
                'button[aria-label*="review"]',
                'button[aria-label*="reviews"]',
                'div.F7nice span:last-child',
                'span.UY7F9',
                'button[jsaction*="reviews"]',
            ];
            for (const sel of reviewsSelectors) {
                try {
                    const el = await page.locator(sel).first();
                    if ((await el.count()) === 0) continue;
                    const txt = await el.textContent().catch(() => null);
                    if (txt) {
                        const m = txt.match(/([\d,\.\s]+)\s*(reviews|review)?/i) || txt.match(/\(?([\d,]+)\)?/);
                        if (m && m[1]) {
                            const num = parseInt(m[1].replace(/[^\d]/g, ''), 10);
                            if (!Number.isNaN(num)) {
                                reviewsCount = num;
                                break;
                            }
                        }
                    }
                } catch (e) {
                    /* continue */
                }
            }

            const address = await trySelectors([
                'button[data-item-id="address"]',
                'button[aria-label*="Address"]',
                'button[aria-label*="address"]',
            ]);
            const phone = await trySelectors([
                'button[data-item-id*="phone"]',
                'button[aria-label*="Phone"]',
                'a[href^="tel:"]',
            ]);
            const website = await tryAttr(['a[data-item-id="authority"]', 'a[aria-label*="Website"]'], 'href');

            let latitude = null;
            let longitude = null;
            try {
                const url = page.url();
                const coords = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                if (coords) {
                    latitude = parseFloat(coords[1]);
                    longitude = parseFloat(coords[2]);
                }
            } catch (e) {
                /* ignore */
            }

            let hours = null;
            try {
                const hoursButton = page.locator('button[data-item-id*="hours"]').first();
                if ((await hoursButton.count()) > 0) {
                    hours = await hoursButton.getAttribute('aria-label').catch(() => null);
                }
                if (!hours) {
                    hours = await page.locator('div[data-item-id*="hours"] .fontBodyMedium').first().textContent().catch(() => null);
                }
                if (!hours) {
                    hours = await page.locator('button[aria-label*="hours" i]').first().getAttribute('aria-label').catch(() => null);
                }
                if (!hours) {
                    const hoursPattern = await page.locator('div[role="region"] >> text=/\d{1,2}.*[AP]M/i').first().textContent().catch(() => null);
                    if (hoursPattern) hours = hoursPattern;
                }
            } catch (e) {
                log.warning(`Hours extraction error: ${e.message}`);
            }

            let images = [];
            if (includeImages) {
                try {
                    const imgHandles = await page
                        .locator('button[aria-label*="Photo"] img, div[role="img"] img')
                        .elementHandles()
                        .catch(() => []);
                    for (const h of imgHandles.slice(0, 5)) {
                        try {
                            const src = await h.getAttribute('src');
                            if (src && src.startsWith('http')) images.push(src);
                        } catch (e) {
                            /* ignore */
                        }
                    }
                } catch (e) {
                    /* ignore */
                }
            }

            const businessData = {
                name: cleanText(name) || undefined,
                category: cleanText(category) || undefined,
                address: cleanText(address) || undefined,
                phone: cleanText(phone) || undefined,
                website: website || undefined,
                rating: rating !== null ? rating : undefined,
                reviewsCount: reviewsCount !== null ? reviewsCount : undefined,
                latitude: latitude || undefined,
                longitude: longitude || undefined,
                hours: cleanHours(hours) || undefined,
                images: images.length > 0 ? images : undefined,
            };

            if (includeReviews && businessData.reviewsCount && businessData.reviewsCount > 0) {
                try {
                    const reviewsButton = await page.$('button[aria-label*="Reviews"]');
                    if (reviewsButton) {
                        await reviewsButton.click();
                        await page.waitForTimeout(2000);
                        const reviews = await page.$$eval('div[data-review-id] span[lang]', (elements) => {
                            return elements.map((el) => el.textContent.trim()).slice(0, 10);
                        });
                        businessData.reviews = reviews.map((r) => cleanText(r)).filter((r) => r);
                    }
                } catch (err) {
                    log.warning(`Failed to extract reviews: ${err.message}`);
                }
            }

            businessData.url = businessUrl;
            businessData.searchQuery = query;
            businessData.scrapedAt = new Date().toISOString();

            if (!businessData.name || businessData.name.trim().length === 0) {
                log.warning(`Skipping business with no name: ${businessUrl}`);
                return;
            }

            await Dataset.pushData(businessData);
            log.info(
                `Saved: ${businessData.name} | Rating: ${businessData.rating || 'N/A'} | Reviews: ${
                    businessData.reviewsCount || 'N/A'
                }`,
            );
        }
    },
    async failedRequestHandler({ request, log }) {
        log.error(`Failed request: ${request.url} - Error: ${request.errorMessages?.join(', ') || 'Unknown error'}`);
        await Dataset.pushData({
            error: true,
            url: request.url,
            query: request.userData.query,
            errorMessage: request.errorMessages?.join(', ') || 'Request failed',
            timestamp: new Date().toISOString(),
        });
    },
});

await crawler.run(startUrls);

const dataset = await Dataset.open();
const { items } = await dataset.getData();
const successfulItems = items.filter((item) => !item.error);
const failedItems = items.filter((item) => item.error);
const itemCount = successfulItems.length;

const businessesWithPhone = successfulItems.filter((b) => b.phone).length;
const businessesWithWebsite = successfulItems.filter((b) => b.website).length;
const businessesWithReviews = successfulItems.filter((b) => b.reviewsCount && b.reviewsCount > 0).length;
const avgRating =
    successfulItems.filter((b) => b.rating).reduce((sum, b) => sum + b.rating, 0) /
        (successfulItems.filter((b) => b.rating).length || 1);

console.log('======================================================================');
console.log('SCRAPING COMPLETED');
console.log('======================================================================');
console.log('RESULTS SUMMARY:');
console.log(`   Total businesses extracted: ${itemCount}`);
console.log(
    `   Businesses with phone: ${businessesWithPhone} (${itemCount ? ((businessesWithPhone / itemCount) * 100).toFixed(1) : 0}%)`,
);
console.log(
    `   Businesses with website: ${businessesWithWebsite} (${itemCount ? ((businessesWithWebsite / itemCount) * 100).toFixed(1) : 0}%)`,
);
console.log(
    `   Businesses with reviews: ${businessesWithReviews} (${itemCount ? ((businessesWithReviews / itemCount) * 100).toFixed(1) : 0}%)`,
);
console.log(`   Average rating: ${avgRating.toFixed(2)}`);
console.log(`   Failed requests: ${failedItems.length}`);
console.log(`   Queries processed: ${validQueries.length}`);
console.log('Data export available in JSON, CSV, Excel');
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
        withReviews: businessesWithReviews,
        phonePercentage: `${itemCount ? ((businessesWithPhone / itemCount) * 100).toFixed(1) : '0.0'}%`,
        websitePercentage: `${itemCount ? ((businessesWithWebsite / itemCount) * 100).toFixed(1) : '0.0'}%`,
        averageRating: parseFloat(avgRating.toFixed(2)),
    },
    searchQueries: validQueries,
    configuration: {
        maxResults,
        includeReviews,
        includeImages,
        language,
        maxConcurrency,
    },
    timestamp: new Date().toISOString(),
    runtimeMs,
};

await Actor.setValue('OUTPUT', runStats);
await Actor.setStatusMessage(
    `Extracted ${itemCount} businesses | Success rate: ${runStats.summary.successRate}`,
    { isStatusMessageTerminal: true },
);

await Actor.exit();
