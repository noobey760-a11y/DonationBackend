require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ============================================================
// DONATION BACKEND
// ============================================================

const GROUP_ID = "795783959";

const ROBLOX_API_KEY =
    process.env.ROBLOX_API_KEY || "";

const INTERNAL_API_KEY =
    process.env.INTERNAL_API_KEY || "";

// ============================================================
// ANALYTICS BRIDGE
// ============================================================

const ANALYTICS_ACCESS_KEY =
    process.env.ANALYTICS_ACCESS_KEY || "";

const ROBLOX_ANALYTICS_API_KEY =
    process.env.ROBLOX_ANALYTICS_API_KEY || "";

const ROBLOX_UNIVERSE_ID =
    String(
        process.env.ROBLOX_UNIVERSE_ID || ""
    ).trim();

const ANALYTICS_API_BASE =
    "https://apis.roblox.com/analytics-query-api";

const ANALYTICS_CACHE_TTL_MS =
    60 * 1000;

const ANALYTICS_TIMEOUT_MS =
    30 * 1000;

const ANALYTICS_POLL_INTERVAL_MS =
    750;

const ANALYTICS_MAX_POLL_ATTEMPTS =
    40;

const ANALYTICS_PERIODS = {
    "7D": 7 * 86400,
    "28D": 28 * 86400,
    "90D": 90 * 86400,
    "365D": 365 * 86400
};

const analyticsCache = new Map();
const analyticsInFlight = new Map();

// ============================================================
// DONATION STORAGE
// ============================================================

const DATA_DIR =
    path.join(__dirname, "data");

const TRANSACTIONS_FILE =
    path.join(
        DATA_DIR,
        "transactions.json"
    );

// ============================================================
// DONATION STORAGE HELPERS
// ============================================================

function ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(
            DATA_DIR,
            { recursive: true }
        );
    }

    if (!fs.existsSync(TRANSACTIONS_FILE)) {
        fs.writeFileSync(
            TRANSACTIONS_FILE,
            JSON.stringify(
                {},
                null,
                2
            ),
            "utf8"
        );
    }
}

function readTransactions() {
    ensureStorage();

    try {
        const text =
            fs.readFileSync(
                TRANSACTIONS_FILE,
                "utf8"
            );

        return JSON.parse(text);
    } catch {
        return {};
    }
}

function writeTransactions(
    transactions
) {
    ensureStorage();

    fs.writeFileSync(
        TRANSACTIONS_FILE,
        JSON.stringify(
            transactions,
            null,
            2
        ),
        "utf8"
    );
}

// ============================================================
// AUTH HELPERS
// ============================================================

function timingSafeEqual(
    a,
    b
) {
    const aBuffer =
        Buffer.from(
            String(a)
        );

    const bBuffer =
        Buffer.from(
            String(b)
        );

    if (
        aBuffer.length !==
        bBuffer.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        aBuffer,
        bBuffer
    );
}

// ------------------------------------------------------------
// EXISTING DONATION AUTH
// ------------------------------------------------------------

function isAuthorized(req) {
    if (!INTERNAL_API_KEY) {
        return false;
    }

    const receivedKey =
        req.header(
            "x-api-key"
        );

    if (!receivedKey) {
        return false;
    }

    return timingSafeEqual(
        receivedKey,
        INTERNAL_API_KEY
    );
}

// ------------------------------------------------------------
// NEW ANALYTICS AUTH
// ------------------------------------------------------------

function isAnalyticsAuthorized(
    req
) {
    if (!ROBLOX_ANALYTICS_API_KEY) {
        return false;
    }

    const receivedKey =
        req.header(
            "x-api-key"
        );

    if (!receivedKey) {
        return false;
    }

    return timingSafeEqual(
        receivedKey,
        ROBLOX_ANALYTICS_API_KEY
    );
}

// ============================================================
// VALIDATION
// ============================================================

function positiveInteger(value) {
    return (
        Number.isInteger(value) &&
        value > 0
    );
}

function nonNegativeInteger(value) {
    return (
        Number.isInteger(value) &&
        value >= 0
    );
}

// ============================================================
// EXISTING ROOT
// ============================================================

app.get(
    "/",
    (_req, res) => {
        res.json({
            ok: true,

            service:
                "Roblox Donation Payout Backend",

            groupId:
                GROUP_ID
        });
    }
);

// ============================================================
// ANALYTICS HEALTH
// ============================================================

app.get(
    "/analytics/health",
    (_req, res) => {
        res.json({
            ok: true,

            service:
                "Roblox Creator Analytics Bridge",

            analyticsAccessKeyConfigured:
                Boolean(
                    ANALYTICS_ACCESS_KEY
                ),

            robloxAnalyticsConfigured:
                Boolean(
                    ROBLOX_ANALYTICS_API_KEY
                ),

            universeConfigured:
                Boolean(
                    ROBLOX_UNIVERSE_ID
                ),

            universeId:
                ROBLOX_UNIVERSE_ID ||
                null
        });
    }
);

// ============================================================
// PAYOUT STATUS
// ============================================================

app.get(
    "/payout/:transactionId",
    (req, res) => {
        if (!isAuthorized(req)) {
            return res.status(401).json({
                ok: false,
                error: "Unauthorized"
            });
        }

        const transactionId =
            String(
                req.params.transactionId || ""
            ).trim();

        if (!transactionId) {
            return res.status(400).json({
                ok: false,
                error:
                    "Missing transactionId"
            });
        }

        const transactions =
            readTransactions();

        const transaction =
            transactions[
                transactionId
            ];

        if (!transaction) {
            return res.status(404).json({
                ok: false,
                error:
                    "Transaction not found"
            });
        }

        return res.json({
            ok: true,
            transaction
        });
    }
);

// ============================================================
// PAYOUT
// ============================================================

app.post(
    "/payout",
    async (req, res) => {
        if (!isAuthorized(req)) {
            return res.status(401).json({
                ok: false,
                error: "Unauthorized"
            });
        }

        if (!ROBLOX_API_KEY) {
            return res.status(500).json({
                ok: false,
                error:
                    "ROBLOX_API_KEY is not configured"
            });
        }

        const {
            transactionId,
            donorUserId,
            recipientUserId,
            grossAmount,
            payoutAmount,
            assetId,
            assetType
        } = req.body || {};

        if (
            typeof transactionId !==
                "string" ||
            transactionId.trim() === ""
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid transactionId"
            });
        }

        if (
            !positiveInteger(
                donorUserId
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid donorUserId"
            });
        }

        if (
            !positiveInteger(
                recipientUserId
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid recipientUserId"
            });
        }

        if (
            donorUserId ===
            recipientUserId
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Self payout is not allowed"
            });
        }

        if (
            !positiveInteger(
                grossAmount
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid grossAmount"
            });
        }

        if (
            !positiveInteger(
                payoutAmount
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid payoutAmount"
            });
        }

        if (
            payoutAmount >
            grossAmount
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "payoutAmount cannot exceed grossAmount"
            });
        }

        if (
            !nonNegativeInteger(
                assetId
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid assetId"
            });
        }

        if (
            typeof assetType !==
                "string" ||
            assetType.trim() === ""
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "Invalid assetType"
            });
        }

        const id =
            transactionId.trim();

        const transactions =
            readTransactions();

        const existing =
            transactions[id];

        if (existing) {
            if (
                existing.recipientUserId !==
                    recipientUserId ||
                existing.payoutAmount !==
                    payoutAmount ||
                existing.grossAmount !==
                    grossAmount
            ) {
                return res.status(409).json({
                    ok: false,
                    error:
                        "Transaction data does not match existing transaction"
                });
            }

            if (
                existing.status ===
                "Paid"
            ) {
                return res.json({
                    ok: true,
                    status: "Paid",
                    duplicate: true,
                    transactionId:
                        id
                });
            }

            if (
                existing.status ===
                "Processing"
            ) {
                return res.status(409).json({
                    ok: false,
                    status:
                        "Processing",
                    transactionId:
                        id
                });
            }
        }

        transactions[id] = {
            transactionId:
                id,

            donorUserId,

            recipientUserId,

            grossAmount,

            payoutAmount,

            assetId,

            assetType,

            status:
                "Processing",

            createdAt:
                existing?.createdAt ||
                new Date().toISOString(),

            updatedAt:
                new Date().toISOString()
        };

        writeTransactions(
            transactions
        );

        try {
            const url =
                `https://groups.roblox.com/v1/groups/${GROUP_ID}/payouts`;

            const response =
                await fetch(
                    url,
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "x-api-key":
                                ROBLOX_API_KEY
                        },

                        body:
                            JSON.stringify({
                                PayoutType:
                                    "FixedAmount",

                                Recipients:
                                    [
                                        {
                                            recipientId:
                                                recipientUserId,

                                            amount:
                                                payoutAmount
                                        }
                                    ]
                            })
                    }
                );

            const responseText =
                await response.text();

            if (!response.ok) {
                transactions[id] = {
                    ...transactions[id],

                    status:
                        "Failed",

                    error:
                        responseText ||
                        `HTTP ${response.status}`,

                    updatedAt:
                        new Date().toISOString()
                };

                writeTransactions(
                    transactions
                );

                return res.status(502).json({
                    ok: false,

                    status:
                        "Failed",

                    transactionId:
                        id,

                    error:
                        responseText ||
                        `Roblox API returned HTTP ${response.status}`
                });
            }

            transactions[id] = {
                ...transactions[id],

                status:
                    "Paid",

                updatedAt:
                    new Date().toISOString()
            };

            writeTransactions(
                transactions
            );

            return res.json({
                ok: true,

                status:
                    "Paid",

                transactionId:
                    id,

                recipientUserId,

                payoutAmount
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            transactions[id] = {
                ...transactions[id],

                status:
                    "Failed",

                error:
                    message,

                updatedAt:
                    new Date().toISOString()
            };

            writeTransactions(
                transactions
            );

            return res.status(500).json({
                ok: false,

                status:
                    "Failed",

                transactionId:
                    id,

                error:
                    message
            });
        }
    }
);

// ============================================================
// ANALYTICS HELPERS
// ============================================================

function normalizeAnalyticsPeriod(
    value
) {
    const period =
        typeof value ===
            "string"
            ? value.toUpperCase()
            : "28D";

    return Object.prototype.hasOwnProperty.call(
        ANALYTICS_PERIODS,
        period
    )
        ? period
        : "28D";
}

function getAnalyticsGranularity(
    period
) {
    if (period === "90D") {
        return "OneWeek";
    }

    if (period === "365D") {
        return "OneMonth";
    }

    return "OneDay";
}

function getAnalyticsTimeoutSignal() {
    return AbortSignal.timeout
        ? AbortSignal.timeout(
            ANALYTICS_TIMEOUT_MS
        )
        : undefined;
}

async function analyticsFetch(
    url,
    options = {}
) {
    const signal =
        getAnalyticsTimeoutSignal();

    const finalOptions = {
        ...options,

        headers: {
            ...(options.headers || {})
        }
    };

    if (signal) {
        finalOptions.signal =
            signal;
    }

    return fetch(
        url,
        finalOptions
    );
}

async function parseAnalyticsJson(
    response
) {
    const text =
        await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(
            text
        );
    } catch {
        return {
            raw:
                text
        };
    }
}

function analyticsApiError(
    status,
    data
) {
    if (
        data &&
        typeof data ===
            "object"
    ) {
        if (
            data.error &&
            typeof data.error ===
                "object" &&
            data.error.message
        ) {
            return (
                `Roblox Analytics API ${status}: ` +
                data.error.message
            );
        }

        if (
            typeof data.message ===
                "string"
        ) {
            return (
                `Roblox Analytics API ${status}: ` +
                data.message
            );
        }
    }

    return (
        `Roblox Analytics API HTTP ${status}`
    );
}

async function pollAnalyticsOperation(
    operationPath
) {
    const cleanPath =
        String(
            operationPath
        ).replace(
            /^\/+/,
            ""
        );

    const url =
        `${ANALYTICS_API_BASE}/${cleanPath}`;

    for (
        let attempt = 0;
        attempt <
            ANALYTICS_MAX_POLL_ATTEMPTS;
        attempt++
    ) {
        await new Promise(
            (resolve) =>
                setTimeout(
                    resolve,
                    ANALYTICS_POLL_INTERVAL_MS
                )
        );

        const response =
            await analyticsFetch(
                url,
                {
                    method:
                        "GET",

                    headers: {
                        "x-api-key":
                            ROBLOX_ANALYTICS_API_KEY
                    }
                }
            );

        const data =
            await parseAnalyticsJson(
                response
            );

        if (!response.ok) {
            throw new Error(
                analyticsApiError(
                    response.status,
                    data
                )
            );
        }

        if (
            data &&
            data.done === true
        ) {
            if (
                data.error
            ) {
                throw new Error(
                    data.error.message ||
                        "Roblox Analytics operation failed."
                );
            }

            return data;
        }
    }

    throw new Error(
        "Roblox Analytics operation timed out."
    );
}

async function queryAnalytics(
    metric,
    granularity,
    startTime,
    endTime,
    options = {}
) {
    const requestBody = {
        metric,

        granularity,

        startTime:
            new Date(
                startTime * 1000
            ).toISOString(),

        endTime:
            new Date(
                endTime * 1000
            ).toISOString()
    };

    if (
        Array.isArray(
            options.breakdown
        ) &&
        options.breakdown.length >
            0
    ) {
        requestBody.breakdown =
            options.breakdown;
    }

    if (
        Array.isArray(
            options.filter
        ) &&
        options.filter.length >
            0
    ) {
        requestBody.filter =
            options.filter;
    }

    if (
        Number.isInteger(
            options.limit
        ) &&
        options.limit > 0
    ) {
        requestBody.limit =
            options.limit;
    }

    const url =
        `${ANALYTICS_API_BASE}` +
        `/v1/universes/` +
        `${encodeURIComponent(
            ROBLOX_UNIVERSE_ID
        )}` +
        `/metrics`;

    const response =
        await analyticsFetch(
            url,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "x-api-key":
                        ROBLOX_ANALYTICS_API_KEY
                },

                body:
                    JSON.stringify(
                        requestBody
                    )
            }
        );

    const data =
        await parseAnalyticsJson(
            response
        );

    if (
        response.status ===
            202 ||
        (
            response.ok &&
            data &&
            data.done === false
        )
    ) {
        if (
            !data ||
            typeof data.path !==
                "string"
        ) {
            throw new Error(
                "Roblox Analytics returned an invalid long-running operation."
            );
        }

        return pollAnalyticsOperation(
            data.path
        );
    }

    if (!response.ok) {
        throw new Error(
            analyticsApiError(
                response.status,
                data
            )
        );
    }

    if (
        data &&
        data.done === true &&
        data.error
    ) {
        throw new Error(
            data.error.message ||
                "Roblox Analytics query failed."
        );
    }

    return data;
}

function normalizeAnalyticsResult(
    data
) {
    const values =
        data?.response?.values;

    if (
        !Array.isArray(values)
    ) {
        return [];
    }

    return values.map(
        (series) => ({
            breakdowns:
                Array.isArray(
                    series?.breakdowns
                )
                    ? series.breakdowns
                    : [],

            dataPoints:
                Array.isArray(
                    series?.dataPoints
                )
                    ? series.dataPoints
                        .map(
                            (point) => ({
                                time:
                                    point?.time ??
                                    null,

                                value:
                                    Number(
                                        point?.value
                                    )
                            })
                        )
                        .filter(
                            (point) =>
                                Number.isFinite(
                                    point.value
                                )
                        )
                    : []
        })
    );
}

async function safeAnalyticsQuery(
    metric,
    granularity,
    startTime,
    endTime,
    options = {}
) {
    try {
        const data =
            await queryAnalytics(
                metric,
                granularity,
                startTime,
                endTime,
                options
            );

        return {
            ok: true,

            metric,

            series:
                normalizeAnalyticsResult(
                    data
                ),

            error:
                null
        };
    } catch (error) {
        return {
            ok: false,

            metric,

            series:
                [],

            error:
                error instanceof Error
                    ? error.message
                    : String(error)
        };
    }
}

function latestPointFromSeries(
    series
) {
    let latest = null;

    for (
        const item
        of series
    ) {
        for (
            const point
            of item.dataPoints ||
            []
        ) {
            if (
                !latest ||
                String(
                    point.time
                ) >
                    String(
                        latest.time
                    )
            ) {
                latest =
                    point;
            }
        }
    }

    return latest;
}

function flattenSeriesPoints(
    series
) {
    return series.flatMap(
        (item) =>
            item.dataPoints ||
            []
    );
}

function analyticsMetricOutput(
    result
) {
    if (
        !result ||
        result.ok !== true
    ) {
        return {
            ok: false,

            points: [],

            latest:
                null,

            breakdowns: [],

            error:
                result?.error ||
                "Unavailable"
        };
    }

    const points =
        flattenSeriesPoints(
            result.series
        );

    return {
        ok: true,

        points,

        latest:
            latestPointFromSeries(
                result.series
            ),

        breakdowns:
            result.series.map(
                (series) => ({
                    breakdowns:
                        series.breakdowns,

                    points:
                        series.dataPoints
                })
            ),

        error:
            null
    };
}

// ============================================================
// ANALYTICS DASHBOARD BUILD
// ============================================================

async function buildAnalyticsDashboard(
    period
) {
    if (
        !ANALYTICS_ACCESS_KEY
    ) {
        throw new Error(
            "ANALYTICS_ACCESS_KEY is not configured on Render."
        );
    }

    if (
        !ROBLOX_ANALYTICS_API_KEY
    ) {
        throw new Error(
            "ROBLOX_ANALYTICS_API_KEY is not configured on Render."
        );
    }

    if (
        !ROBLOX_UNIVERSE_ID
    ) {
        throw new Error(
            "ROBLOX_UNIVERSE_ID is not configured on Render."
        );
    }

    const now =
        Math.floor(
            Date.now() / 1000
        );

    const start =
        now -
        ANALYTICS_PERIODS[
            period
        ];

    const granularity =
        getAnalyticsGranularity(
            period
        );

    const performanceStart =
        Math.max(
            start,
            now -
                28 *
                    86400
        );

    const recentStart =
        now -
        35 *
            86400;

    const definitions = {
        // ----------------------------------------------------
        // ENGAGEMENT
        // ----------------------------------------------------

        dau: [
            "DailyActiveUsers",
            granularity,
            start,
            now,
            {}
        ],

        mau: [
            "MonthlyActiveUsers",
            "OneDay",
            recentStart,
            now,
            {}
        ],

        averageSession: [
            "AverageSessionLengthMinutes",
            "None",
            start,
            now,
            {}
        ],

        averagePlaytimePerDAU: [
            "AveragePlayTimeMinutesPerDAU",
            "None",
            start,
            now,
            {}
        ],

        totalPlaytime: [
            "TotalPlayTimeHours",
            "None",
            start,
            now,
            {}
        ],

        visits: [
            "Visits",
            "None",
            start,
            now,
            {}
        ],

        stickiness: [
            "DauMauStickiness",
            "OneDay",
            recentStart,
            now,
            {}
        ],

        sessionsByDay: [
            "Visits",
            "OneDay",
            start,
            now,
            {}
        ],

        // ----------------------------------------------------
        // RETENTION
        // ----------------------------------------------------

        d1: [
            "ForwardD1Retention",
            "OneDay",
            start,
            now,
            {}
        ],

        d7: [
            "ForwardD7Retention",
            "OneDay",
            start,
            now,
            {}
        ],

        d30: [
            "ForwardD30Retention",
            "OneDay",
            start,
            now,
            {}
        ],

        dailyCohortRetention: [
            "DailyCohortRetention",
            "OneDay",
            start,
            now,
            {}
        ],

        // ----------------------------------------------------
        // MONETIZATION
        // ----------------------------------------------------

        revenue: [
            "DailyRevenue",
            "None",
            start,
            now,
            {}
        ],

        revenueChart: [
            "DailyRevenue",
            granularity,
            start,
            now,
            {}
        ],

        payingUsers: [
            "PayingUsers",
            "None",
            start,
            now,
            {}
        ],

        payerCVR: [
            "PayingUsersCVR",
            "None",
            start,
            now,
            {}
        ],

        arpdau: [
            "AverageRevenuePerUser",
            "None",
            start,
            now,
            {}
        ],

        arppu: [
            "AverageRevenuePerPayingUser",
            "None",
            start,
            now,
            {}
        ],

        // ----------------------------------------------------
        // ACQUISITION
        // ----------------------------------------------------

        clickCVR: [
            "ClickCVR",
            "None",
            start,
            now,
            {}
        ],

        endToEndCVR: [
            "EndToEndCVR",
            "None",
            start,
            now,
            {}
        ],

        impressionCVR: [
            "ImpressionCVR",
            "None",
            start,
            now,
            {}
        ],

        qualifiedEndToEndCVR: [
            "QualifiedEndToEndCVR",
            "None",
            start,
            now,
            {}
        ],

        uniqueUsersWithClicks: [
            "UniqueUsersWithClicks",
            "None",
            start,
            now,
            {}
        ],

        uniqueUsersWithImpressions: [
            "UniqueUsersWithImpressions",
            "None",
            start,
            now,
            {}
        ],

        uniqueUsersWithPlaySessions: [
            "UniqueUsersWithPlaySessions",
            "None",
            start,
            now,
            {}
        ],

        qualifiedUniqueUsersWithPlaySessions: [
            "QualifiedUniqueUsersWithPlaySessions",
            "None",
            start,
            now,
            {}
        ],

        // ----------------------------------------------------
        // PERFORMANCE
        // ----------------------------------------------------

        fpsAvg: [
            "ClientFpsAvg",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        fpsP10: [
            "ClientFpsP10",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        fpsP50: [
            "ClientFpsP50",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        fpsP90: [
            "ClientFpsP90",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        crashRate: [
            "ClientCrashRate15m",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        clientCrashCount: [
            "ClientCrashCount",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        clientMemoryP50: [
            "ClientMemoryUsageP50",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        clientMemoryP90: [
            "ClientMemoryUsageP90",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        clientCpuAvg: [
            "ClientCpuTimeAvg",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        sessionAverage: [
            "SessionDurationSecondsAvg",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        sessionP50: [
            "SessionDurationSecondsP50",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        sessionP90: [
            "SessionDurationSecondsP90",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        peakCCU: [
            "PeakConcurrentPlayers",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        serverCrashCount: [
            "ServerCrashCount",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        serverFrameRateAvg: [
            "ServerFrameRateAvg",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        serverFrameRateP50: [
            "ServerFrameRateP50",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        serverFrameRateP90: [
            "ServerFrameRateP90",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        serverMemoryP50: [
            "MemoryUsageP50",
            "OneDay",
            performanceStart,
            now,
            {}
        ],

        // ----------------------------------------------------
        // AUDIENCE
        // ----------------------------------------------------

        platformDAU: [
            "DailyActiveUsers",
            "None",
            start,
            now,
            {
                breakdown:
                    ["Platform"],

                limit: 10
            }
        ],

        countryDAU: [
            "DailyActiveUsers",
            "None",
            start,
            now,
            {
                breakdown:
                    ["Country"],

                limit: 10
            }
        ],

        newVsReturningDAU: [
            "DailyActiveUsers",
            granularity,
            start,
            now,
            {
                breakdown:
                    ["IsNewUser"]
            }
        ],

        // ----------------------------------------------------
        // CHARTS
        // ----------------------------------------------------

        playtimeChart: [
            "TotalPlayTimeHours",
            granularity,
            start,
            now,
            {}
        ]
    };

    const results = {};

    await Promise.all(
        Object.entries(
            definitions
        ).map(
            async (
                [
                    name,
                    args
                ]
            ) => {
                results[name] =
                    await safeAnalyticsQuery(
                        ...args
                    );
            }
        )
    );

    const errors = {};

    for (
        const [
            name,
            result
        ]
        of Object.entries(
            results
        )
    ) {
        if (
            !result ||
            result.ok !== true
        ) {
            errors[name] =
                result?.error ||
                "Unavailable";
        }
    }

    return {
        ok: true,

        source:
            "Roblox Creator Analytics API",

        universeId:
            ROBLOX_UNIVERSE_ID,

        period,

        startTime:
            new Date(
                start * 1000
            ).toISOString(),

        endTime:
            new Date(
                now * 1000
            ).toISOString(),

        generatedAt:
            new Date().toISOString(),

        engagement: {
            dau:
                analyticsMetricOutput(
                    results.dau
                ),

            mau:
                analyticsMetricOutput(
                    results.mau
                ),

            averageSession:
                analyticsMetricOutput(
                    results.averageSession
                ),

            averagePlaytimePerDAU:
                analyticsMetricOutput(
                    results.averagePlaytimePerDAU
                ),

            totalPlaytime:
                analyticsMetricOutput(
                    results.totalPlaytime
                ),

            visits:
                analyticsMetricOutput(
                    results.visits
                ),

            stickiness:
                analyticsMetricOutput(
                    results.stickiness
                ),

            sessionsByDay:
                analyticsMetricOutput(
                    results.sessionsByDay
                )
        },

        retention: {
            d1:
                analyticsMetricOutput(
                    results.d1
                ),

            d7:
                analyticsMetricOutput(
                    results.d7
                ),

            d30:
                analyticsMetricOutput(
                    results.d30
                ),

            dailyCohort:
                analyticsMetricOutput(
                    results.dailyCohortRetention
                )
        },

        monetization: {
            revenue:
                analyticsMetricOutput(
                    results.revenue
                ),

            revenueChart:
                analyticsMetricOutput(
                    results.revenueChart
                ),

            payingUsers:
                analyticsMetricOutput(
                    results.payingUsers
                ),

            payerCVR:
                analyticsMetricOutput(
                    results.payerCVR
                ),

            arpdau:
                analyticsMetricOutput(
                    results.arpdau
                ),

            arppu:
                analyticsMetricOutput(
                    results.arppu
                )
        },

        acquisition: {
            clickCVR:
                analyticsMetricOutput(
                    results.clickCVR
                ),

            endToEndCVR:
                analyticsMetricOutput(
                    results.endToEndCVR
                ),

            impressionCVR:
                analyticsMetricOutput(
                    results.impressionCVR
                ),

            qualifiedEndToEndCVR:
                analyticsMetricOutput(
                    results.qualifiedEndToEndCVR
                ),

            uniqueUsersWithClicks:
                analyticsMetricOutput(
                    results.uniqueUsersWithClicks
                ),

            uniqueUsersWithImpressions:
                analyticsMetricOutput(
                    results.uniqueUsersWithImpressions
                ),

            uniqueUsersWithPlaySessions:
                analyticsMetricOutput(
                    results.uniqueUsersWithPlaySessions
                ),

            qualifiedUniqueUsersWithPlaySessions:
                analyticsMetricOutput(
                    results.qualifiedUniqueUsersWithPlaySessions
                )
        },

        performance: {
            fpsAvg:
                analyticsMetricOutput(
                    results.fpsAvg
                ),

            fpsP10:
                analyticsMetricOutput(
                    results.fpsP10
                ),

            fpsP50:
                analyticsMetricOutput(
                    results.fpsP50
                ),

            fpsP90:
                analyticsMetricOutput(
                    results.fpsP90
                ),

            crashRate:
                analyticsMetricOutput(
                    results.crashRate
                ),

            clientCrashCount:
                analyticsMetricOutput(
                    results.clientCrashCount
                ),

            clientMemoryP50:
                analyticsMetricOutput(
                    results.clientMemoryP50
                ),

            clientMemoryP90:
                analyticsMetricOutput(
                    results.clientMemoryP90
                ),

            clientCpuAvg:
                analyticsMetricOutput(
                    results.clientCpuAvg
                ),

            sessionAverage:
                analyticsMetricOutput(
                    results.sessionAverage
                ),

            sessionP50:
                analyticsMetricOutput(
                    results.sessionP50
                ),

            sessionP90:
                analyticsMetricOutput(
                    results.sessionP90
                ),

            peakCCU:
                analyticsMetricOutput(
                    results.peakCCU
                ),

            serverCrashCount:
                analyticsMetricOutput(
                    results.serverCrashCount
                ),

            serverFrameRateAvg:
                analyticsMetricOutput(
                    results.serverFrameRateAvg
                ),

            serverFrameRateP50:
                analyticsMetricOutput(
                    results.serverFrameRateP50
                ),

            serverFrameRateP90:
                analyticsMetricOutput(
                    results.serverFrameRateP90
                ),

            serverMemoryP50:
                analyticsMetricOutput(
                    results.serverMemoryP50
                )
        },

        audience: {
            platformDAU:
                analyticsMetricOutput(
                    results.platformDAU
                ),

            countryDAU:
                analyticsMetricOutput(
                    results.countryDAU
                ),

            newVsReturningDAU:
                analyticsMetricOutput(
                    results.newVsReturningDAU
                )
        },

        charts: {
            dau:
                analyticsMetricOutput(
                    results.dau
                ),

            playtime:
                analyticsMetricOutput(
                    results.playtimeChart
                ),

            revenue:
                analyticsMetricOutput(
                    results.revenueChart
                )
        },

        errors
    };
}

// ============================================================
// ANALYTICS ROUTE
// ============================================================

app.post(
    "/analytics",
    async (req, res) => {
        if (
            !isAnalyticsAuthorized(
                req
            )
        ) {
            return res.status(401).json({
                ok: false,
                error:
                    "Unauthorized"
            });
        }

        const period =
            normalizeAnalyticsPeriod(
                req.body?.period
            );

        const requestedUniverse =
            String(
                req.body?.universeId ||
                    ""
            ).trim();

        if (
            requestedUniverse &&
            requestedUniverse !==
                ROBLOX_UNIVERSE_ID
        ) {
            return res.status(403).json({
                ok: false,
                error:
                    "Universe ID mismatch"
            });
        }

        const cached =
            analyticsCache.get(
                period
            );

        if (
            cached &&
            Date.now() -
                cached.createdAt <
                ANALYTICS_CACHE_TTL_MS
        ) {
            return res.json(
                cached.data
            );
        }

        const existingPromise =
            analyticsInFlight.get(
                period
            );

        if (existingPromise) {
            try {
                const data =
                    await existingPromise;

                return res.json(
                    data
                );
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                return res.status(502).json({
                    ok: false,
                    error: message
                });
            }
        }

        const promise =
            buildAnalyticsDashboard(
                period
            );

        analyticsInFlight.set(
            period,
            promise
        );

        try {
            const data =
                await promise;

            analyticsCache.set(
                period,
                {
                    createdAt:
                        Date.now(),

                    data
                }
            );

            return res.json(
                data
            );
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            console.error(
                "[Analytics]",
                message
            );

            return res.status(502).json({
                ok: false,
                error: message
            });
        } finally {
            analyticsInFlight.delete(
                period
            );
        }
    }
);

// ============================================================
// START
// ============================================================

ensureStorage();

app.listen(
    PORT,
    () => {
        console.log(
            `Donation backend running on port ${PORT}`
        );

        console.log(
            `[Analytics] Access key: ${
                ANALYTICS_ACCESS_KEY
                    ? "configured"
                    : "MISSING"
            }`
        );

        console.log(
            `[Analytics] Roblox API key: ${
                ROBLOX_ANALYTICS_API_KEY
                    ? "configured"
                    : "MISSING"
            }`
        );

        console.log(
            `[Analytics] Universe ID: ${
                ROBLOX_UNIVERSE_ID
                    ? ROBLOX_UNIVERSE_ID
                    : "MISSING"
            }`
        );
    }
);
