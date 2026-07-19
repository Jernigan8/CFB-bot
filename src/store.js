import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export async function loadLeague(storePath = config.storePath) {
  const raw = await fs.readFile(storePath, "utf8");
  return JSON.parse(raw);
}

export async function saveLeague(league, storePath = config.storePath) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(league, null, 2)}\n`, "utf8");
}

export async function seedLeague({ force = false } = {}) {
  try {
    if (!force) {
      await fs.access(config.storePath);
      throw new Error(`League store already exists at ${config.storePath}. Use --force to overwrite it.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !force) {
      throw error;
    }
  }

  const sample = await fs.readFile(config.samplePath, "utf8");
  await fs.mkdir(path.dirname(config.storePath), { recursive: true });
  await fs.writeFile(config.storePath, sample, "utf8");
  return config.storePath;
}
