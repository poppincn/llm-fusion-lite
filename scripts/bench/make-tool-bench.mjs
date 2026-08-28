#!/usr/bin/env node
/**
 * Generate a tool-sensitive benchmark: exact-computation items whose answers are
 * deterministic (computed here with BigInt) and which models reliably get wrong
 * unaided, but a tool-using agent can nail. This is the FAIR test of agentic
 * fusion (failures are computational, not conceptual like gpqa-18). Free-form
 * exact-match grading on the integer.
 *
 *   node scripts/bench/make-tool-bench.mjs > scripts/bench/data/tool_bench.jsonl
 */
function modpow(b, e, m) {
    b %= m;
    let r = 1n;
    while (e > 0n) {
        if (e & 1n) r = (r * b) % m;
        b = (b * b) % m;
        e >>= 1n;
    }
    return r;
}
function isqrt(n) {
    if (n < 2n) return n;
    let x = n,
        y = (x + 1n) >> 1n;
    while (y < x) {
        x = y;
        y = (x + n / x) >> 1n;
    }
    return x;
}
function gcd(a, b) {
    while (b) {
        [a, b] = [b, a % b];
    }
    return a;
}
function binom(n, k) {
    if (k < 0n || k > n) return 0n;
    k = k < n - k ? k : n - k;
    let r = 1n;
    for (let i = 0n; i < k; i++) r = (r * (n - i)) / (i + 1n);
    return r;
}
function fact(n) {
    let r = 1n;
    for (let i = 2n; i <= n; i++) r *= i;
    return r;
}
// primes up to limit (sieve)
function sieve(limit) {
    const s = new Uint8Array(limit + 1);
    const p = [];
    for (let i = 2; i <= limit; i++) {
        if (!s[i]) {
            p.push(i);
            for (let j = i * i; j <= limit; j += i) s[j] = 1;
        }
    }
    return p;
}
const primes = sieve(300000);

const items = [
    { id: "calc-pow", prompt: "Compute 89 raised to the 17th power (89^17) exactly.", answer: (89n ** 17n).toString() },
    { id: "calc-modpow", prompt: "Compute 7^131 mod 1000000007.", answer: modpow(7n, 131n, 1000000007n).toString() },
    {
        id: "calc-binom",
        prompt: "Compute the binomial coefficient C(80, 23) exactly.",
        answer: binom(80n, 23n).toString()
    },
    {
        id: "calc-isqrt",
        prompt: "Compute floor(sqrt(10^40)) as an exact integer.",
        answer: isqrt(10n ** 40n).toString()
    },
    {
        id: "calc-gcd",
        prompt: "Compute gcd(123456789012345678, 98765432109876543).",
        answer: gcd(123456789012345678n, 98765432109876543n).toString()
    },
    { id: "calc-product", prompt: "Compute 999983 multiplied by 999979.", answer: (999983n * 999979n).toString() },
    {
        id: "calc-nthprime",
        prompt: "What is the 7000th prime number? (the 1st prime is 2)",
        answer: String(primes[6999])
    },
    {
        id: "calc-sumprimes",
        prompt: "Compute the sum of the first 2000 prime numbers.",
        answer: String(primes.slice(0, 2000).reduce((a, b) => a + b, 0))
    },
    {
        id: "calc-factdigits",
        prompt: "How many digits are in 250! (250 factorial) when written in base 10?",
        answer: String(fact(250n).toString().length)
    },
    {
        id: "calc-datediff",
        prompt: "How many days elapse from 1985-11-07 to 2026-06-28 (the count of days between these two dates)?",
        answer: String(Math.round((Date.UTC(2026, 5, 28) - Date.UTC(1985, 10, 7)) / 86400000))
    }
];

for (const it of items) {
    it.prompt +=
        " Give the exact result as a plain integer with no commas, spaces, or words. End with a line exactly: FINAL ANSWER: <integer>";
    process.stdout.write(JSON.stringify(it) + "\n");
}
process.stderr.write(`wrote ${items.length} computation items\n`);
