import { getEncoding, type Tiktoken } from "js-tiktoken";
import { PESSIMISTIC_TOKEN_MARGIN } from "./constants";

/**
 * Lazy singleton instance of the Tiktoken cl100k_base tokenizer.
 */
let tokenizerInstance: Tiktoken | null = null;

/**
 * Returns the lazily-initialized Tiktoken singleton.
 */
function getTokenizer(): Tiktoken {
  if (!tokenizerInstance) {
    tokenizerInstance = getEncoding("cl100k_base");
  }
  return tokenizerInstance;
}

/**
 * Counts raw tokens for a given string using the cl100k_base encoding.
 * Returns 0 if text is empty, whitespace-only, or has length 0.
 */
export function countRawTokens(text: string): number {
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return 0;
  }
  return getTokenizer().encode(text).length;
}

/**
 * Estimates input tokens with a pessimistic safety margin (+15%)
 * to absorb provider and multilingual tokenization variances.
 * If raw tokens is 0, returns 0.
 */
export function estimatePessimisticInputTokens(text: string): number {
  const rawTokens = countRawTokens(text);
  if (rawTokens === 0) {
    return 0;
  }
  return Math.ceil(rawTokens * PESSIMISTIC_TOKEN_MARGIN);
}
