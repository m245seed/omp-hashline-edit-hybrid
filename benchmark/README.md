# Benchmark suite

Run after dependencies are installed:

```
npx tsx benchmark/bench.ts
```

The suite exercises the current 1k/10k/50k anchor, document, mutation,
served-state, persistence, and tool paths using temporary projects and state
stores, and cleans them up when finished. It is an observational regression
check: record its output as a baseline and watch for import/type/runtime
failures or unexpected regressions, rather than enforcing a fixed timing
threshold.
