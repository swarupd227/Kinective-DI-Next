// Training a model on demand. DI trains its models when it starts; if that ran before the data was
// ready (a seed still rebuilding the tables, say) or failed, nothing would try again until the next
// restart. So when someone asks about a model that isn't in use, its agent starts the first training
// itself, once at a time, and says so. Tests and evals never train this way (they train explicitly).
export function trainOnDemand(bootstrap: () => Promise<unknown>, label: string) {
  let running: Promise<unknown> | null = null;
  return () => {
    if (process.env.VITEST || process.env.DI_ML_BOOTSTRAP === '0') return false;
    if (!running) {
      running = bootstrap()
        .catch((e: unknown) => console.error(`${label}, training on demand:`, e))
        .finally(() => {
          running = null;
        });
    }
    return true;
  };
}
