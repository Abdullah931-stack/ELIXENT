import dotenv from "dotenv";

/**
 * Loads local environment files for standalone server execution while
 * preserving any variables already injected by the host environment
 * and keeping test runtimes isolated.
 */
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  dotenv.config({ path: ".env.local" });
  dotenv.config();
}
