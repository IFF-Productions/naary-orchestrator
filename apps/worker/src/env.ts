import { resolve } from "node:path";
import { config } from "dotenv";

// Load the repo-root .env (DATABASE_URL, ENCRYPTION_KEY) before any @naary/*
// module evaluates. Import this FIRST in the worker entrypoint.
config({ path: resolve(__dirname, "../../../.env") });
