import { createInterface } from "node:readline/promises";

/** Asks the user to type `expected` back to confirm. Returns false (never
 * blocks) when stdin isn't a terminal, so scripted runs must opt in with a
 * flag instead of hanging on a prompt nobody can answer. */
export async function confirmByTyping(
  message: string,
  expected: string,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message}\nType "${expected}" to confirm: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}
