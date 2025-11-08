import cors from "cors";
import express from "express";
import morgan from "morgan";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, "../data/ratings.json");

class RatingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Record<string, { ratings: Record<string, RatingEntry> }>} */
    this.data = {};
    this.writeQueue = Promise.resolve();
  }

  async init() {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.data = parsed;
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        await this.persist();
        return;
      }
      throw error;
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.filePath, `${payload}\n`, "utf-8");
  }

  schedulePersist() {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    return this.writeQueue;
  }

  ensureUniverse(universeId) {
    if (!this.data[universeId]) {
      this.data[universeId] = { ratings: {} };
    }
    return this.data[universeId];
  }

  getSummary(universeId, userId) {
    const record = this.data[universeId];
    const distribution = [1, 2, 3, 4, 5].map((stars) => ({
      stars,
      count: 0,
    }));

    if (!record) {
      return {
        universeId,
        averageRating: 0,
        totalRatings: 0,
        distribution,
        userRating: null,
      };
    }

    const ratings = Object.entries(record.ratings);
    let sum = 0;
    for (const [, entry] of ratings) {
      if (!entry || typeof entry.rating !== "number") continue;
      const starsIndex = Math.min(Math.max(entry.rating, 1), 5) - 1;
      distribution[starsIndex].count += 1;
      sum += entry.rating;
    }

    const totalRatings = ratings.length;
    const averageRating = totalRatings === 0 ? 0 : Number((sum / totalRatings).toFixed(2));

    const userRating = userId && record.ratings[userId] ? record.ratings[userId] : null;

    return {
      universeId,
      averageRating,
      totalRatings,
      distribution,
      userRating,
    };
  }

  async upsert(universeId, userId, rating, metadata = {}) {
    const numericRating = Number.parseInt(`${rating}`, 10);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      throw new Error("Rating must be an integer between 1 and 5.");
    }
    const record = this.ensureUniverse(universeId);
    record.ratings[userId] = {
      rating: numericRating,
      username: metadata.username ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.schedulePersist();
    return this.getSummary(universeId, userId);
  }

  async remove(universeId, userId) {
    const record = this.data[universeId];
    if (!record || !record.ratings[userId]) {
      return this.getSummary(universeId);
    }

    delete record.ratings[userId];
    if (Object.keys(record.ratings).length === 0) {
      delete this.data[universeId];
    }

    await this.schedulePersist();
    return this.getSummary(universeId);
  }
}

/**
 * @typedef {Object} RatingEntry
 * @property {number} rating
 * @property {string|null} username
 * @property {string} updatedAt
 */

const store = new RatingsStore(DATA_FILE);

function validateUniverseId(universeId) {
  if (!/^\d+$/.test(universeId)) {
    const error = new Error("Universe ID must be a numeric string.");
    error.statusCode = 400;
    throw error;
  }
  return universeId;
}

function validateUserId(userId) {
  if (!userId || !/^\d+$/.test(userId)) {
    const error = new Error("User ID must be provided as a numeric string.");
    error.statusCode = 400;
    throw error;
  }
  return userId;
}

async function bootstrap() {
  await store.init();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10kb" }));
  app.use(morgan("dev"));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/games/:universeId/ratings", (req, res, next) => {
    try {
      const universeId = validateUniverseId(req.params.universeId);
      const userId = req.query.userId ? validateUserId(`${req.query.userId}`) : undefined;
      const summary = store.getSummary(universeId, userId);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/games/:universeId/ratings", async (req, res, next) => {
    try {
      const universeId = validateUniverseId(req.params.universeId);
      const userId = validateUserId(`${req.body?.userId ?? ""}`);
      const rating = req.body?.rating;
      const username = typeof req.body?.username === "string" ? req.body.username : undefined;
      const summary = await store.upsert(universeId, userId, rating, { username });
      res.status(201).json(summary);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/games/:universeId/ratings/:userId", async (req, res, next) => {
    try {
      const universeId = validateUniverseId(req.params.universeId);
      const userId = validateUserId(req.params.userId);
      const summary = await store.remove(universeId, userId);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err, _req, res, _next) => {
    const statusCode = err?.statusCode ?? 500;
    const message = err?.message ?? "Unexpected error";
    if (statusCode >= 500) {
      console.error(err);
    }
    res.status(statusCode).json({ error: message });
  });

  const port = Number.parseInt(process.env.PORT ?? "4000", 10);
  app.listen(port, () => {
    console.log(`RBDb backend listening on port ${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start RBDb backend", error);
  process.exit(1);
});
