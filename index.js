const { addonBuilder, serveHTTP, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const BASE_URL = process.env.BLUDV_BASE_URL || "https://bludv2.xyz";
const API_URL = `${BASE_URL}/wp-json/wp/v2/posts`;
const CINEMETA_URL = "https://v3-cinemeta.strem.io";
const FETCH_TIMEOUT = 10000;
const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; BLUDV-Stremio-Addon/1.0; +https://www.stremio.com/)",
    Accept: "application/json,text/plain,*/*",
};

// Category IDs from WordPress
const CATEGORY_FILMES = 92;
const CATEGORY_SERIES = 10;

// Cache IMDb ID -> post data mapping
const imdbCache = new Map();

const manifest = {
    id: "community.bludv",
    version: "1.0.0",
    catalogs: [
        {
            type: "movie",
            id: "bludv-filmes",
            name: "BLUDV Filmes",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false },
            ],
        },
        {
            type: "series",
            id: "bludv-series",
            name: "BLUDV Séries",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false },
            ],
        },
    ],
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    name: "BLUDV",
    description: "Addon para Stremio com conteúdo do BLUDV - Filmes e Séries Torrent Dublados",
    logo: "https://bludv2.xyz/wp-content/uploads/2021/07/logo.png",
};

const builder = new addonBuilder(manifest);

// Parse post content to extract metadata
function parsePostContent(post) {
    const content = post.content.rendered;
    const title = post.title.rendered
        .replace(/&#8211;/g, "-")
        .replace(/&amp;/g, "&")
        .replace(/&#8217;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"');

    // Extract IMDb ID
    const imdbMatch = content.match(/imdb\.com\/(?:pt\/)?title\/(tt\d+)/);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    // Extract poster image
    const posterMatch = content.match(/image\.tmdb\.org\/t\/p\/w300\/([^'"]+)/);
    const poster = posterMatch
        ? `https://image.tmdb.org/t/p/w500/${posterMatch[1]}`
        : null;

    // Extract year
    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    // Extract original title
    const origTitleMatch = content.match(/T[ií]tulo Original:<\/em><\/strong>\s*([^<]+)/);
    const originalTitle = origTitleMatch ? origTitleMatch[1].trim() : null;

    // Extract genre
    const genreMatch = content.match(/G[êe]nero:<\/em><\/strong>\s*([^<]+)/);
    const genres = genreMatch ? genreMatch[1].trim().split(/\s*\|\s*/) : [];

    // Extract magnet links with their descriptions from surrounding context
    const magnetLinks = [];
    const sections = content.split(/<center>/i);
    let currentVersion = "";

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const cleanSection = section.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
            .replace(/&#8211;/g, "–").replace(/&amp;/g, "&").replace(/&#038;/g, "&").trim();

        // Check if this is a VERSÃO header
        if (/^VERS[ÃA]O\s/i.test(cleanSection)) {
            currentVersion = cleanSection.split("\n")[0].trim();
        }

        // Check if this section has a SERVIDOR description
        const servidorMatch = cleanSection.match(/SERVIDOR PARA DOWNLOAD[^\n]*/i);
        const servidorDesc = servidorMatch ? servidorMatch[0].trim() : "";

        // Check if this section has a magnet link
        const magnetMatch = section.match(/magnet:\?xt=urn:btih:[^"<\s]+/);
        if (magnetMatch) {
            let magnetUrl = magnetMatch[0].replace(/&amp;/g, "&").replace(/&#038;/g, "&");
            magnetLinks.push({
                url: magnetUrl,
                version: currentVersion,
                servidor: servidorDesc,
            });
        }
    }

    // Extract quality/resolution info from title
    const resolutionMatch = title.match(/(720p|1080p|4K|3D)/i);
    const resolution = resolutionMatch ? resolutionMatch[1] : "";

    // Extract quality info from content
    const qualityMatch = content.match(/Qualidade:<\/em><\/strong>\s*([^<]+)/);
    const quality = qualityMatch ? qualityMatch[1].trim() : "";

    // Extract audio info
    const audioMatch = content.match(/[ÁA]udio:<\/em><\/strong>\s*([^<]+)/);
    const audio = audioMatch ? audioMatch[1].trim() : "";

    // Extract size
    const sizeMatch = content.match(/Tamanho:<\/em><\/strong>\s*([^<]+)/);
    const size = sizeMatch ? sizeMatch[1].trim() : "";

    // Clean title for display
    const cleanTitle = title
        .replace(/\s*Torrent\s*/gi, " ")
        .replace(/\s*\(\d{4}\)\s*/, " ")
        .replace(/\s*WEB-DL\s*/gi, "")
        .replace(/\s*BluRay\s*/gi, "")
        .replace(/\s*Blu-ray Rip\s*/gi, "")
        .replace(/\s*720p\/1080p\/4K\s*/gi, "")
        .replace(/\s*720p\/1080p\s*/gi, "")
        .replace(/\s*1080p\s*/gi, "")
        .replace(/\s*720p\s*/gi, "")
        .replace(/\s*4K\s*/gi, "")
        .replace(/\s*3D\s*/gi, "")
        .replace(/\s*Dual [ÁA]udio\s*/gi, "")
        .replace(/\s*Legendado\s*/gi, "")
        .replace(/\s*Dublado\s*/gi, "")
        .replace(/\s*\d+[ªa] Temporada\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    return {
        id: imdbId || `bludv:${post.id}`,
        postId: post.id,
        title: cleanTitle,
        originalTitle,
        year,
        poster,
        genres,
        imdbId,
        magnetLinks,
        quality,
        resolution,
        audio,
        size,
        postUrl: post.link,
        rawTitle: title,
    };
}

function normalizeTitle(value) {
    return (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&amp;/g, "&")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function base32ToHex(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    let hex = "";

    for (const char of value.toUpperCase().replace(/=+$/, "")) {
        const index = alphabet.indexOf(char);
        if (index === -1) return null;
        bits += index.toString(2).padStart(5, "0");
    }

    for (let i = 0; i + 4 <= bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }

    return hex.length === 40 ? hex : null;
}

function extractInfoHash(magnetUrl) {
    const match = magnetUrl.match(/btih:([^&]+)/i);
    if (!match) return null;

    const hash = decodeURIComponent(match[1]).trim();
    if (/^[a-f0-9]{40}$/i.test(hash)) return hash.toLowerCase();
    if (/^[a-z2-7]{32}$/i.test(hash)) return base32ToHex(hash);
    return null;
}

// Fetch with timeout
async function fetchWithTimeout(url, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            headers: FETCH_HEADERS,
            signal: controller.signal,
        });
        clearTimeout(timer);
        return response;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

// Fetch posts from WordPress API
async function fetchPosts(options = {}) {
    const params = new URLSearchParams();
    params.set("per_page", options.perPage || 20);
    params.set("page", options.page || 1);

    if (options.category) {
        params.set("categories", options.category);
    }
    if (options.search) {
        params.set("search", options.search);
    }

    const url = `${API_URL}?${params.toString()}`;
    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`BLUDV API returned ${response.status} for ${url}`);
            return [];
        }
        return await response.json();
    } catch (err) {
        console.error("Error fetching posts:", err.message);
        return [];
    }
}

async function fetchCinemetaMeta(type, imdbId) {
    try {
        const url = `${CINEMETA_URL}/meta/${type}/${imdbId}.json`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`Cinemeta returned ${response.status} for ${url}`);
            return null;
        }
        const data = await response.json();
        return data.meta || null;
    } catch (err) {
        console.error("Error fetching Cinemeta metadata:", err.message);
        return null;
    }
}

async function findPostsByTitle(type, meta) {
    const category = type === "movie" ? CATEGORY_FILMES : CATEGORY_SERIES;
    const titles = [
        meta.name,
        meta.originalName,
        meta.imdbRating ? null : meta.releaseInfo,
    ].filter(Boolean);
    const seenPostIds = new Set();
    const matches = [];

    for (const title of titles) {
        const posts = await fetchPosts({
            search: title,
            category,
            perPage: 10,
            page: 1,
        });
        const targetTitle = normalizeTitle(title);

        for (const post of posts) {
            if (seenPostIds.has(post.id)) continue;

            const parsed = parsePostContent(post);
            const parsedTitles = [
                parsed.title,
                parsed.originalTitle,
                parsed.rawTitle,
            ].map(normalizeTitle);
            const titleMatches = parsedTitles.some((parsedTitle) =>
                parsedTitle.includes(targetTitle) || targetTitle.includes(parsedTitle)
            );

            if (titleMatches || matches.length === 0) {
                seenPostIds.add(post.id);
                matches.push(post);
            }
        }

        if (matches.length > 0) break;
    }

    return matches;
}

// Search for a specific IMDb ID in posts
async function findPostByImdbId(imdbId) {
    // Check cache first
    if (imdbCache.has(imdbId)) {
        const cachedPostId = imdbCache.get(imdbId);
        try {
            const response = await fetchWithTimeout(`${API_URL}/${cachedPostId}`);
            if (response.ok) {
                return [await response.json()];
            }
            console.error(`BLUDV API returned ${response.status} for cached post ${cachedPostId}`);
        } catch (err) {
            // Cache miss, continue to search
        }
    }

    // Search WordPress by the IMDb title number
    const params = new URLSearchParams();
    params.set("per_page", 20);
    params.set("search", imdbId.replace("tt", ""));

    try {
        // Try searching with full IMDb ID first
        const url1 = `${API_URL}?per_page=5&search=${imdbId}`;
        const response1 = await fetchWithTimeout(url1);
        if (response1.ok) {
            const posts = await response1.json();
            const matching = posts.filter((p) =>
                p.content.rendered.includes(imdbId)
            );
            if (matching.length > 0) return matching;
        } else {
            console.error(`BLUDV API returned ${response1.status} for IMDb search ${imdbId}`);
        }
    } catch (err) {
        console.error("Error in IMDb search:", err.message);
    }

    return [];
}

// Catalog handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const category = type === "movie" ? CATEGORY_FILMES : CATEGORY_SERIES;
    const skip = extra.skip ? Math.floor(parseInt(extra.skip) / 20) + 1 : 1;

    let posts;
    if (extra.search) {
        posts = await fetchPosts({ search: extra.search, category, page: 1 });
    } else {
        posts = await fetchPosts({ category, page: skip });
    }

    const metas = posts.map((post) => {
        const parsed = parsePostContent(post);
        // Cache the IMDb ID -> post ID mapping
        if (parsed.imdbId) {
            imdbCache.set(parsed.imdbId, parsed.postId);
        }
        return {
            id: parsed.id,
            type,
            name: parsed.title,
            poster: parsed.poster,
            year: parsed.year,
            description: `${parsed.quality} ${parsed.resolution} | ${parsed.audio}`.trim(),
            genres: parsed.genres,
        };
    });

    return { metas };
});

// Stream handler
builder.defineStreamHandler(async ({ type, id }) => {
    let posts = [];
    const imdbId = id.split(":")[0];

    if (imdbId.startsWith("tt")) {
        posts = await findPostByImdbId(imdbId);
        if (posts.length === 0) {
            const meta = await fetchCinemetaMeta(type, imdbId);
            if (meta) {
                posts = await findPostsByTitle(type, meta);
            }
        }
    } else if (id.startsWith("bludv:")) {
        const postId = id.replace("bludv:", "");
        try {
            const response = await fetchWithTimeout(`${API_URL}/${postId}`);
            if (response.ok) {
                posts = [await response.json()];
            } else {
                console.error(`BLUDV API returned ${response.status} for post ${postId}`);
            }
        } catch (err) {
            console.error("Error fetching post:", err.message);
        }
    }

    if (posts.length === 0) {
        return { streams: [] };
    }

    const streams = [];
    for (const post of posts) {
        const parsed = parsePostContent(post);
        for (const magnet of parsed.magnetLinks) {
            const infoHash = extractInfoHash(magnet.url);

            let streamTitle = `🇧🇷 BLUDV`;
            if (magnet.servidor) {
                streamTitle += `\n${magnet.servidor}`;
            }
            if (magnet.version) {
                streamTitle += `\n${magnet.version}`;
            }

            if (infoHash) {
                // Extract tracker URLs from magnet link
                const trackers = [];
                const trRegex = /[&?]tr=([^&]+)/g;
                let trMatch;
                while ((trMatch = trRegex.exec(magnet.url)) !== null) {
                    trackers.push("tracker:" + decodeURIComponent(trMatch[1]));
                }

                const streamObj = {
                    title: streamTitle,
                    infoHash: infoHash,
                };
                if (trackers.length > 0) {
                    streamObj.sources = trackers;
                }
                streams.push(streamObj);
            }
        }
    }

    return { streams };
});

// Export for Vercel serverless
const addonInterface = builder.getInterface();

if (require.main === module) {
    // Running locally
    const PORT = process.env.PORT || 7000;
    serveHTTP(addonInterface, { port: PORT });
    console.log(`BLUDV Stremio Addon running on port ${PORT}`);
    console.log(`Install URL: http://localhost:${PORT}/manifest.json`);
}

module.exports = addonInterface;
