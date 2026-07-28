const express = require("express");
const path = require("path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const DEFAULT_GALLERY_FOLDER = process.env.GALLERY_FOLDER_NAME || "students-as-co-creators";

const CLOUDINARY_POOL_LIMIT = Number(process.env.CLOUDINARY_POOL_LIMIT) || 1800;
const CLOUDINARY_PAGE_SIZE = Math.min(500, Number(process.env.CLOUDINARY_PAGE_SIZE) || 500);
const GALLERY_RETURN_LIMIT_DEFAULT = Number(process.env.GALLERY_RETURN_LIMIT_DEFAULT) || 36;
const GALLERY_RETURN_LIMIT_MAX = Number(process.env.GALLERY_RETURN_LIMIT_MAX) || 100;
const GALLERY_CACHE_TTL_MS = Number(process.env.GALLERY_CACHE_TTL_MS) || 5 * 60 * 1000;
const GALLERY_WARM_POOL_MIN = Number(process.env.GALLERY_WARM_POOL_MIN) || 60;

const folderCache = new Map();

function pickRandomSubset(items, count) {
    const limit = Math.max(0, Math.min(count, items.length));
    const shuffled = items.slice();

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const temp = shuffled[index];
        shuffled[index] = shuffled[swapIndex];
        shuffled[swapIndex] = temp;
    }

    return shuffled.slice(0, limit);
}

function parseRequestedLimit(rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return GALLERY_RETURN_LIMIT_DEFAULT;
    }

    return Math.min(Math.floor(parsed), GALLERY_RETURN_LIMIT_MAX);
}

async function fetchCloudinaryFolderAssets(folderName, limit = CLOUDINARY_POOL_LIMIT) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
        throw new Error("Missing Cloudinary environment variables.");
    }
    const authorization = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

    const resources = [];
    let nextCursor = null;

    while (resources.length < limit) {
        const params = new URLSearchParams({
            asset_folder: folderName,
            max_results: String(Math.min(CLOUDINARY_PAGE_SIZE, limit - resources.length))
        });

        if (nextCursor) {
            params.set("next_cursor", nextCursor);
        }

        const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/by_asset_folder?${params.toString()}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `Basic ${authorization}`,
                Accept: "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`Cloudinary asset lookup failed with status ${response.status}`);
        }

        const payload = await response.json();
        const batch = Array.isArray(payload.resources) ? payload.resources : [];
        resources.push(...batch);

        nextCursor = payload.next_cursor || null;
        if (!nextCursor || batch.length === 0) {
            break;
        }
    }

    return resources.slice(0, limit);
}

function getOrCreateCacheEntry(folderName) {
    const existing = folderCache.get(folderName);
    if (existing) {
        return existing;
    }

    const created = {
        fetchedAt: 0,
        resources: [],
        refreshPromise: null
    };

    folderCache.set(folderName, created);
    return created;
}

function schedulePoolRefresh(folderName) {
    const entry = getOrCreateCacheEntry(folderName);
    if (entry.refreshPromise) {
        return entry.refreshPromise;
    }

    entry.refreshPromise = (async () => {
        const resources = await fetchCloudinaryFolderAssets(folderName, CLOUDINARY_POOL_LIMIT);
        entry.resources = resources;
        entry.fetchedAt = Date.now();
    })()
        .catch((error) => {
            // Keep stale cache data if refresh fails.
            console.error(`Pool refresh failed for folder '${folderName}':`, error.message);
        })
        .finally(() => {
            entry.refreshPromise = null;
        });

    return entry.refreshPromise;
}

async function getFolderPoolFast(folderName, requestedLimit) {
    const now = Date.now();
    const entry = getOrCreateCacheEntry(folderName);
    const isFresh = entry.resources.length > 0 && now - entry.fetchedAt < GALLERY_CACHE_TTL_MS;

    if (isFresh) {
        return entry.resources;
    }

    if (entry.resources.length > 0) {
        schedulePoolRefresh(folderName);
        return entry.resources;
    }

    const warmPoolTarget = Math.max(GALLERY_WARM_POOL_MIN, requestedLimit * 2);
    const warmResources = await fetchCloudinaryFolderAssets(folderName, Math.min(warmPoolTarget, CLOUDINARY_POOL_LIMIT));
    entry.resources = warmResources;
    entry.fetchedAt = Date.now();

    if (warmResources.length < CLOUDINARY_POOL_LIMIT) {
        return entry.resources;
    }

    schedulePoolRefresh(folderName);
    return entry.resources;
}

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

app.get("/config.js", (_req, res) => {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "";
    const galleryFolderName = DEFAULT_GALLERY_FOLDER;
    res.type("application/javascript");
    res.send(`window.__APP_CONFIG__ = { CLOUDINARY_CLOUD_NAME: ${JSON.stringify(cloudName)}, GALLERY_FOLDER_NAME: ${JSON.stringify(galleryFolderName)} };`);
});

app.get("/gallery-assets", async (req, res) => {
    const folderName = String(req.query.folder || DEFAULT_GALLERY_FOLDER);
    const requestedLimit = parseRequestedLimit(req.query.limit);

    try {
        const resources = await getFolderPoolFast(folderName, requestedLimit);
        const selectedResources = pickRandomSubset(resources, requestedLimit);

        res.json({
            folder: folderName,
            pool_size: resources.length,
            selected_count: selectedResources.length,
            resources: selectedResources.map((resource) => ({
                public_id: resource.public_id,
                width: resource.width,
                height: resource.height,
                resource_type: resource.resource_type,
                type: resource.type,
                format: resource.format,
                asset_folder: resource.asset_folder
            }))
        });
    } catch (error) {
        res.status(500).json({
            error: "Unable to load gallery assets.",
            message: error.message
        });
    }
});

app.use(express.static(path.join(__dirname)));

app.listen(port, () => {
    console.log(`students-as-co-creators site listening on port ${port}`);
    schedulePoolRefresh(DEFAULT_GALLERY_FOLDER);
});
