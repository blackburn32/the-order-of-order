// Worker bootstrap for the TypeScript batch driver. Node workers do not inherit
// the tsx CLI's loader, so register it inside the worker before importing the
// shared entry module.
import { register } from "tsx/esm/api";

register();
await import("./runBatch.ts");
