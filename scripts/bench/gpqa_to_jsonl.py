#!/usr/bin/env python3
"""Convert a GPQA CSV (e.g. gpqa_diamond.csv) into the benchmark harness's
objective MCQ JSONL format. Deterministic option shuffle (seeded per row) so
runs are reproducible and the correct letter isn't always 'A'.

Usage: python3 scripts/bench/gpqa_to_jsonl.py <gpqa.csv> <out.jsonl>
"""
import csv, json, random, sys

LETTERS = "ABCDEFGH"


def clean(s: str) -> str:
    return (s or "").strip()


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: gpqa_to_jsonl.py <gpqa.csv> <out.jsonl>", file=sys.stderr)
        sys.exit(1)
    src, out = sys.argv[1], sys.argv[2]
    rows = list(csv.DictReader(open(src, encoding="utf-8")))
    written = 0
    with open(out, "w", encoding="utf-8") as f:
        for i, row in enumerate(rows):
            q = clean(row.get("Question"))
            correct = clean(row.get("Correct Answer"))
            incs = [clean(row.get(f"Incorrect Answer {k}")) for k in (1, 2, 3)]
            opts = [correct] + [x for x in incs if x]
            if not q or not correct or len(opts) < 2:
                continue
            order = opts[:]
            random.Random(i).shuffle(order)  # deterministic per-row shuffle
            ans = LETTERS[order.index(correct)]
            body = "\n".join(f"{LETTERS[j]}) {o}" for j, o in enumerate(order))
            choice_letters = ", ".join(LETTERS[: len(order)])
            prompt = f"{q}\n\n{body}\n\nAnswer with the single letter ({choice_letters}) only."
            f.write(json.dumps({"id": f"gpqa-{i + 1}", "prompt": prompt, "choices": order, "answer": ans}) + "\n")
            written += 1
    print(f"wrote {out}: {written} items (from {len(rows)} rows)")


if __name__ == "__main__":
    main()
