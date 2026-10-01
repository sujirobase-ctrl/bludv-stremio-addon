const { addonBuilder, serveHTTP, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const BASE_URL = process.env.BLUDV_BASE_URL || "https://bludv2.xyz";
const API_URL = `${BASE_URL}/wp-json/wp/v2/posts`;
const WP_SEARCH_URL = `${BASE_URL}/wp-json/wp/v2/search`;
const CINEMETA_URL = "https://v3-cinemeta.strem.io";
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
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
const postCache = new Map();
const titleCache = new Map();

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

function decodeHtml(value) {
    return (value || "")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

// Parse post content to extract metadata
function parsePostContent(post) {
    const content = post.content.rendered;
    const title = decodeHtml(post.title.rendered);

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
    return decodeHtml(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function cleanSearchTitle(value) {
    return decodeHtml(value || "")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\b(temporada|season|torrent|download|dual audio|dual áudio|dublado|legendado|web dl|webrip|bluray|blu ray|hdrip|hdtv|remux|proper|complete|completa)\b/gi, " ")
        .replace(/\b(720p|1080p|2160p|4k|3d|x264|x265|hevc|10bit)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getTitleQueries(meta) {
    const candidates = [
        meta.name,
        meta.originalName,
        ...(meta.altTitles || []),
        meta.name && meta.name.replace(/^the\s+/i, ""),
        meta.originalName && meta.originalName.replace(/^the\s+/i, ""),
        ...(meta.altTitles || []).map((title) => title.replace(/^the\s+/i, "")),
    ];
    const queries = [];
    const seen = new Set();

    for (const candidate of candidates) {
        const cleaned = cleanSearchTitle(candidate);
        if (!cleaned) continue;

        const variants = [
            cleaned,
            cleaned.split(":")[0].trim(),
            cleaned.split("-")[0].trim(),
        ];

        for (const variant of variants) {
            const key = normalizeTitle(variant);
            if (key.length >= 3 && !seen.has(key)) {
                seen.add(key);
                queries.push(variant);
            }
        }
    }

    return queries;
}

function titleScore(post, meta, queries) {
    const parsed = parsePostContent(post);
    const postTitles = [
        parsed.title,
        parsed.originalTitle,
        parsed.rawTitle,
    ].map(normalizeTitle).filter(Boolean);
    const queryTitles = queries.map(normalizeTitle).filter(Boolean);
    const releaseYear = String(meta.year || meta.releaseInfo || "").match(/\d{4}/)?.[0];
    let score = 0;

    for (const query of queryTitles) {
        const queryWords = query.split(" ").filter((word) => word.length > 2);
        for (const postTitle of postTitles) {
            if (postTitle === query) score = Math.max(score, 100);
            if (postTitle.includes(query) || query.includes(postTitle)) score = Math.max(score, 80);

            const matchedWords = queryWords.filter((word) => postTitle.includes(word)).length;
            if (queryWords.length > 0) {
                score = Math.max(score, Math.round((matchedWords / queryWords.length) * 60));
            }
        }
    }

    if (releaseYear && parsed.year === parseInt(releaseYear, 10)) {
        score += 20;
    }

    if (parsed.magnetLinks.length > 0) {
        score += 10;
    }

    return score;
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

async function fetchAlternativeTitles(imdbId) {
    if (titleCache.has(imdbId)) {
        return titleCache.get(imdbId);
    }

    const query = `
SELECT ?itemLabel ?ptLabel ?alias WHERE {
  ?item wdt:P345 "${imdbId}".
  OPTIONAL { ?item rdfs:label ?ptLabel FILTER(LANG(?ptLabel) IN ("pt", "pt-br")) }
  OPTIONAL { ?item skos:altLabel ?alias FILTER(LANG(?alias) IN ("pt", "pt-br", "en")) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt-br,pt,en". }
}
LIMIT 50`;
    const url = `${WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`;
    const titles = new Set();

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`Wikidata returned ${response.status} for IMDb ${imdbId}`);
            titleCache.set(imdbId, []);
            return [];
        }

        const data = await response.json();
        for (const row of data.results.bindings) {
            for (const field of ["itemLabel", "ptLabel", "alias"]) {
                const title = row[field]?.value;
                if (title && !/^Q\d+$/.test(title)) {
                    titles.add(title);
                }
            }
        }
    } catch (err) {
        console.error("Error fetching Wikidata titles:", err.message);
    }

    const result = [...titles];
    titleCache.set(imdbId, result);
    return result;
}

async function enrichMetaWithAlternativeTitles(meta, imdbId) {
    const altTitles = await fetchAlternativeTitles(imdbId);
    return {
        ...meta,
        altTitles,
    };
}

async function fetchPostById(postId) {
    if (postCache.has(postId)) {
        return postCache.get(postId);
    }

    try {
        const response = await fetchWithTimeout(`${API_URL}/${postId}`);
        if (!response.ok) {
            console.error(`BLUDV API returned ${response.status} for post ${postId}`);
            return null;
        }
        const post = await response.json();
        postCache.set(postId, post);
        return post;
    } catch (err) {
        console.error("Error fetching post:", err.message);
        return null;
    }
}

async function fetchWpSearchPosts(search) {
    const params = new URLSearchParams();
    params.set("search", search);
    params.set("per_page", 20);
    params.set("subtype", "post");

    const url = `${WP_SEARCH_URL}?${params.toString()}`;
    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`BLUDV search API returned ${response.status} for ${url}`);
            return [];
        }

        const results = await response.json();
        const posts = [];
        for (const result of results) {
            const post = await fetchPostById(result.id);
            if (post) posts.push(post);
        }
        return posts;
    } catch (err) {
        console.error("Error searching BLUDV posts:", err.message);
        return [];
    }
}

async function findPostsByTitle(type, meta) {
    const category = type === "movie" ? CATEGORY_FILMES : CATEGORY_SERIES;
    const queries = getTitleQueries(meta);
    const seenPostIds = new Set();
    const scoredMatches = [];

    for (const query of queries) {
        const searchBatches = [
            fetchPosts({ search: query, category, perPage: 20, page: 1 }),
            fetchPosts({ search: query, perPage: 20, page: 1 }),
            fetchWpSearchPosts(query),
        ];
        const batches = await Promise.all(searchBatches);
        const posts = batches.flat();

        for (const post of posts) {
            if (seenPostIds.has(post.id)) continue;

            seenPostIds.add(post.id);
            const score = titleScore(post, meta, queries);
            if (score >= 45 || (score >= 30 && parsePostContent(post).magnetLinks.length > 0)) {
                scoredMatches.push({ post, score });
            }
        }
    }

    return scoredMatches
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((match) => match.post);
}

// Search for a specific IMDb ID in posts
async function findPostByImdbId(imdbId) {
    // Check cache first
    if (imdbCache.has(imdbId)) {
        const cachedPostId = imdbCache.get(imdbId);
        const cachedPost = await fetchPostById(cachedPostId);
        if (cachedPost) {
            return [cachedPost];
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
                const enrichedMeta = await enrichMetaWithAlternativeTitles(meta, imdbId);
                posts = await findPostsByTitle(type, enrichedMeta);
            }
        }
    } else if (id.startsWith("bludv:")) {
        const postId = id.replace("bludv:", "");
        const post = await fetchPostById(postId);
        if (post) {
            posts = [post];
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
