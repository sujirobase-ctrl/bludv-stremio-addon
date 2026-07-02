const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../index");

const router = getRouter(addonInterface);

module.exports = (req, res) => {
    // Add CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }

    // Strip /api prefix if present (Vercel routing adds it)
    if (req.url.startsWith("/api/")) {
        req.url = req.url.replace("/api", "");
    }

    router(req, res, () => {
        res.statusCode = 404;
        res.end();
    });
};
