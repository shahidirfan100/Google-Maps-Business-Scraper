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

        const randomDelay = 800 + Math.floor(Math.random() * 400);
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

const seenBusinessUrls = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 5,
            maxErrorScore: 1,
        },
    },
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
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-web-security',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--window-size=1920,1080',
            ],
        },
    },
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 2,
    maxRequestsPerCrawl: maxResults * validQueries.length + 100,
    preNavigationHooks: [
        async ({ page, request }) => {
            if (!page.__gmapsStealthInit) {
                page.__gmapsStealthInit = true;
                await page.addInitScript(() => {
                    // Hide webdriver
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    delete navigator.__proto__.webdriver;

                    // Set realistic languages
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

                    // Fake plugins array
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => {
                            const plugins = [
                                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                                { name: 'Native Client', filename: 'internal-nacl-plugin' },
                            ];
                            plugins.length = 3;
                            return plugins;
                        }
                    });

                    // Set proper platform
                    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

                    // Hide automation indicators
                    window.chrome = {
                        runtime: {},
                        loadTimes: () => { },
                        csi: () => { },
                        app: {}
                    };

                    // Prevent detection via permissions
                    const originalQuery = window.navigator.permissions?.query;
                    if (originalQuery) {
                        window.navigator.permissions.query = (parameters) => {
                            if (parameters.name === 'notifications') {
                                return Promise.resolve({ state: 'denied', onchange: null });
                            }
                            return originalQuery(parameters);
                        };
                    }

                    // Set realistic screen properties
                    Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
                    Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
                    Object.defineProperty(screen, 'width', { get: () => 1920 });
                    Object.defineProperty(screen, 'height', { get: () => 1080 });
                    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                });

                await page.route('**/*', (route) => {
                    const resourceType = route.request().resourceType();
                    const url = route.request().url();

                    // Block unnecessary resources for speed and cost optimization
                    if (['font', 'media', 'stylesheet'].includes(resourceType)) {
                        return route.abort();
                    }

                    // Block images in fast mode or on search pages
                    if (page.__gmapsBlockImages && resourceType === 'image') {
                        return route.abort();
                    }

                    // Block review-related XHR if not collecting reviews
                    if (!includeReviews && resourceType === 'xhr' && /review/i.test(url)) {
                        return route.abort();
                    }

                    // Block analytics and tracking
                    if (/analytics|doubleclick|google-analytics|googletagmanager/i.test(url)) {
                        return route.abort();
                    }

                    return route.continue();
                });
            }

            page.__gmapsBlockImages = fastMode || !includeImages || request.userData?.label === 'SEARCH';

            page.setDefaultTimeout(15000);
            page.setDefaultNavigationTimeout(60000);
            await page.setExtraHTTPHeaders({
                'accept-language': language ? `${language},en;q=0.8` : 'en-US,en;q=0.8',
            });
        },
    ],
    async requestHandler({ page, request, log }) {
        const { label, query, businessUrl } = request.userData;

        if (label === 'SEARCH') {
            log.info(`Processing search: ${query}`);

            // Handle Google consent dialog/cookie popup
            try {
                const consentSelectors = [
                    'button[aria-label*="Accept all"]',
                    'button[aria-label*="Reject all"]',
                    'form[action*="consent"] button',
                    'button:has-text("Accept all")',
                    'button:has-text("Reject all")',
                    '[aria-label="Accept all"]',
                    'button.VfPpkd-LgbsSe[jsname]',
                ];

                for (const selector of consentSelectors) {
                    try {
                        const consentBtn = page.locator(selector).first();
                        if (await consentBtn.isVisible({ timeout: 3000 })) {
                            await consentBtn.click({ timeout: 5000 });
                            log.info('Dismissed consent dialog');
                            await page.waitForTimeout(2000);
                            break;
                        }
                    } catch {
                        // Ignore - try next selector
                    }
                }
            } catch (err) {
                log.debug(`Consent dialog check: ${err.message}`);
            }

            // Wait for page to stabilize after potential consent handling
            await page.waitForLoadState('domcontentloaded');

            // Try multiple selectors for the results feed
            const feedSelectors = [
                'div[role="feed"]',
                'div[role="main"] div[role="feed"]',
                'div.m6QErb[role="feed"]',
                'div[aria-label*="Results"]',
            ];

            let feedFound = false;
            for (const selector of feedSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 30000 });
                    feedFound = true;
                    log.info(`Feed found using selector: ${selector}`);
                    break;
                } catch {
                    log.debug(`Selector ${selector} not found, trying next...`);
                }
            }

            if (!feedFound) {
                // Check if we got blocked or page didn't load properly
                const pageContent = await page.content();
                if (pageContent.includes('unusual traffic') || pageContent.includes('captcha')) {
                    log.error('Detected CAPTCHA or bot detection, session likely blocked');
                    throw new Error('Bot detection triggered');
                }

                // Try clicking search button if needed
                const searchBox = await page.$('input[aria-label*="Search"]');
                if (searchBox) {
                    await searchBox.press('Enter');
                    await page.waitForTimeout(3000);
                    feedFound = await page.$('div[role="feed"]') !== null;
                }

                if (!feedFound) {
                    log.error(`Feed not found after all attempts, skipping query: ${query}`);
                    return;
                }
            }

            const randomWait = 1000 + Math.floor(Math.random() * 500);
            await page.waitForTimeout(randomWait);
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

            if (limitedLinks.length > 0) {
                await crawler.addRequests(
                    limitedLinks.map((detailUrl) => ({
                        url: detailUrl,
                        userData: { label: 'DETAIL', query, businessUrl: detailUrl },
                    })),
                );
            }
            return;
        }

        if (label === 'DETAIL') {
            log.info(`Extracting business details from: ${businessUrl}`);

            try {
                await page.waitForSelector('h1', { timeout: 15000 });
            } catch (err) {
                log.debug(`Heading wait timed out: ${err.message}`);
            }

            const extracted = await page.evaluate((captureImages) => {
                const pickText = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent) {
                            const txt = el.textContent.trim();
                            if (txt) return txt;
                        }
                    }
                    return null;
                };

                const pickAttr = (selectors, attr) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const val = el.getAttribute(attr);
                        if (val) return val;
                    }
                    return null;
                };

                const name = pickText(['h1', 'h1 span', 'div[role="main"] h1']);
                const category = pickText([
                    'button[jsaction*="category"]',
                    'button[aria-label*="Category"]',
                    'div[role="main"] button:nth-of-type(1)',
                ]);
                const ratingText =
                    pickAttr(['span[aria-label*="stars"]', 'div.F7nice span[aria-label*="stars"]'], 'aria-label') ||
                    pickText(['span.ceNzKf', 'span.MW4etd', 'div.F7nice span[aria-hidden="true"]']);
                const reviewsText =
                    pickAttr(['button[aria-label*="review"]', 'button[aria-label*="reviews"]'], 'aria-label') ||
                    pickText(['div.F7nice span:last-child', 'span.UY7F9', 'button[jsaction*="reviews"]']);
                const address = pickText([
                    'button[data-item-id="address"]',
                    'button[aria-label*="Address"]',
                    'button[aria-label*="address"]',
                ]);
                const phone = pickText([
                    'button[data-item-id*="phone"]',
                    'button[aria-label*="Phone"]',
                    'a[href^="tel:"]',
                ]);
                const website = pickAttr(['a[data-item-id="authority"]', 'a[aria-label*="Website"]'], 'href');

                let hours = null;
                const hoursButton = document.querySelector('button[data-item-id*="hours"]');
                if (hoursButton) hours = hoursButton.getAttribute('aria-label');
                if (!hours) hours = pickText(['div[data-item-id*="hours"] .fontBodyMedium']);
                if (!hours) hours = pickAttr(['button[aria-label*="hours" i]'], 'aria-label');
                if (!hours) {
                    const regionText = pickText(['div[role="region"]']);
                    if (regionText && /\d{1,2}.*[AP]M/i.test(regionText)) hours = regionText;
                }

                const imageUrls = new Set();
                if (captureImages) {
                    const imgNodes = document.querySelectorAll('button[aria-label*="Photo"] img, div[role="img"] img');
                    for (const img of imgNodes) {
                        const src =
                            img.getAttribute('src') ||
                            img.getAttribute('data-src') ||
                            img.getAttribute('data-iurl') ||
                            img.getAttribute('data-lazy-src');
                        if (src && src.startsWith('http')) imageUrls.add(src);
                        if (imageUrls.size >= 5) break;
                    }

                    if (imageUrls.size < 5) {
                        const bgNodes = document.querySelectorAll('div[role="img"][style*="url("]');
                        for (const node of bgNodes) {
                            const style = node.getAttribute('style') || '';
                            const match = style.match(/url\("?(https?:[^")]+)"?\)/);
                            if (match && match[1]) imageUrls.add(match[1]);
                            if (imageUrls.size >= 5) break;
                        }
                    }
                }

                return {
                    name,
                    category,
                    ratingText,
                    reviewsText,
                    address,
                    phone,
                    website,
                    hours,
                    images: Array.from(imageUrls),
                };
            }, includeImages);

            const rating = parseRating(extracted.ratingText);
            const reviewsCount = parseReviewsCount(extracted.reviewsText);

            let coords = parseCoordsFromUrl(businessUrl);
            if (!coords.latitude || !coords.longitude) {
                coords = parseCoordsFromUrl(page.url());
            }

            const businessData = {
                name: cleanText(extracted.name) || undefined,
                category: cleanText(extracted.category) || undefined,
                address: cleanText(extracted.address) || undefined,
                phone: cleanText(extracted.phone) || undefined,
                website: extracted.website || undefined,
                rating: rating !== null ? rating : undefined,
                reviewsCount: reviewsCount !== null ? reviewsCount : undefined,
                latitude: coords.latitude || undefined,
                longitude: coords.longitude || undefined,
                hours: cleanHours(extracted.hours) || undefined,
                images: includeImages && extracted.images.length > 0 ? extracted.images : undefined,
            };

            if (!businessData.name) {
                try {
                    const pgTitle = await page.title().catch(() => null);
                    if (pgTitle && pgTitle.trim().length) {
                        businessData.name = cleanText(pgTitle.split('-')[0]);
                    } else {
                        const metaEl = await page.$('meta[property="og:title"],meta[name="title"]');
                        if (metaEl) {
                            const content = await metaEl.getAttribute('content').catch(() => null);
                            if (content) businessData.name = cleanText(content);
                        }
                    }
                } catch (err) {
                    log.debug(`Fallback title extraction failed: ${err.message}`);
                }
            }

            if (includeReviews && businessData.reviewsCount && businessData.reviewsCount > 0) {
                try {
                    const reviewsButton = page
                        .locator('button[aria-label*="Reviews" i], button[jsaction*="reviews"]')
                        .first();
                    if ((await reviewsButton.count()) > 0) {
                        await reviewsButton.click({ timeout: 3000 });
                        await page.waitForSelector('div[data-review-id]', { timeout: 5000 });
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
                `Saved: ${businessData.name} | Rating: ${businessData.rating || 'N/A'} | Reviews: ${businessData.reviewsCount || 'N/A'
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
        fastMode,
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
