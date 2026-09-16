require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const GROUP_ID = "795783959";

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

const DATA_DIR = path.join(__dirname, "data");
const TRANSACTIONS_FILE = path.join(DATA_DIR, "transactions.json");

function ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(TRANSACTIONS_FILE)) {
        fs.writeFileSync(
            TRANSACTIONS_FILE,
            JSON.stringify({}, null, 2),
            "utf8"
        );
    }
}

function readTransactions() {
    ensureStorage();

    try {
        const text = fs.readFileSync(
            TRANSACTIONS_FILE,
            "utf8"
        );

        return JSON.parse(text);
    } catch {
        return {};
    }
}

function writeTransactions(transactions) {
    ensureStorage();

    fs.writeFileSync(
        TRANSACTIONS_FILE,
        JSON.stringify(transactions, null, 2),
        "utf8"
    );
}

function timingSafeEqual(a, b) {
    const aBuffer = Buffer.from(String(a));
    const bBuffer = Buffer.from(String(b));

    if (aBuffer.length !== bBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function isAuthorized(req) {
    if (!INTERNAL_API_KEY) {
        return false;
    }

    const receivedKey = req.header("x-api-key");

    if (!receivedKey) {
        return false;
    }

    return timingSafeEqual(
        receivedKey,
        INTERNAL_API_KEY
    );
}

function positiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}

app.get("/", (_req, res) => {
    res.json({
        ok: true,
        service: "Roblox Donation Payout Backend",
        groupId: GROUP_ID
    });
});

app.get("/payout/:transactionId", (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({
            ok: false,
            error: "Unauthorized"
        });
    }

    const transactionId = String(
        req.params.transactionId || ""
    ).trim();

    if (!transactionId) {
        return res.status(400).json({
            ok: false,
            error: "Missing transactionId"
        });
    }

    const transactions = readTransactions();
    const transaction = transactions[transactionId];

    if (!transaction) {
        return res.status(404).json({
            ok: false,
            error: "Transaction not found"
        });
    }

    return res.json({
        ok: true,
        transaction
    });
});

app.post("/payout", async (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({
            ok: false,
            error: "Unauthorized"
        });
    }

    if (!ROBLOX_API_KEY) {
        return res.status(500).json({
            ok: false,
            error: "ROBLOX_API_KEY is not configured"
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
        typeof transactionId !== "string" ||
        transactionId.trim() === ""
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid transactionId"
        });
    }

    if (!positiveInteger(donorUserId)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid donorUserId"
        });
    }

    if (!positiveInteger(recipientUserId)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid recipientUserId"
        });
    }

    if (donorUserId === recipientUserId) {
        return res.status(400).json({
            ok: false,
            error: "Self payout is not allowed"
        });
    }

    if (!positiveInteger(grossAmount)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid grossAmount"
        });
    }

    if (!positiveInteger(payoutAmount)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid payoutAmount"
        });
    }

    if (payoutAmount > grossAmount) {
        return res.status(400).json({
            ok: false,
            error: "payoutAmount cannot exceed grossAmount"
        });
    }

    if (!nonNegativeInteger(assetId)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid assetId"
        });
    }

    if (
        typeof assetType !== "string" ||
        assetType.trim() === ""
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid assetType"
        });
    }

    const id = transactionId.trim();

    const transactions = readTransactions();
    const existing = transactions[id];

    if (existing) {
        if (
            existing.recipientUserId !== recipientUserId ||
            existing.payoutAmount !== payoutAmount ||
            existing.grossAmount !== grossAmount
        ) {
            return res.status(409).json({
                ok: false,
                error: "Transaction data does not match existing transaction"
            });
        }

        if (existing.status === "Paid") {
            return res.json({
                ok: true,
                status: "Paid",
                duplicate: true,
                transactionId: id
            });
        }

        if (existing.status === "Processing") {
            return res.status(409).json({
                ok: false,
                status: "Processing",
                transactionId: id
            });
        }
    }

    transactions[id] = {
        transactionId: id,
        donorUserId,
        recipientUserId,
        grossAmount,
        payoutAmount,
        assetId,
        assetType,
        status: "Processing",
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    writeTransactions(transactions);

    try {
        const url =
            `https://groups.roblox.com/v1/groups/${GROUP_ID}/payouts`;

        const response = await fetch(
            url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": ROBLOX_API_KEY
                },
                body: JSON.stringify({
                    PayoutType: "FixedAmount",
                    Recipients: [
                        {
                            recipientId: recipientUserId,
                            amount: payoutAmount
                        }
                    ]
                })
            }
        );

        const responseText = await response.text();

        if (!response.ok) {
            transactions[id] = {
                ...transactions[id],
                status: "Failed",
                error: responseText || `HTTP ${response.status}`,
                updatedAt: new Date().toISOString()
            };

            writeTransactions(transactions);

            return res.status(502).json({
                ok: false,
                status: "Failed",
                transactionId: id,
                error: responseText || `Roblox API returned HTTP ${response.status}`
            });
        }

        transactions[id] = {
            ...transactions[id],
            status: "Paid",
            updatedAt: new Date().toISOString()
        };

        writeTransactions(transactions);

        return res.json({
            ok: true,
            status: "Paid",
            transactionId: id,
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
            status: "Failed",
            error: message,
            updatedAt: new Date().toISOString()
        };

        writeTransactions(transactions);

        return res.status(500).json({
            ok: false,
            status: "Failed",
            transactionId: id,
            error: message
        });
    }
});

ensureStorage();

app.listen(PORT, () => {
    console.log(
        `Donation backend running on port ${PORT}`
    );
});
