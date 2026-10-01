// Worker bootstrap for the goal grid (sim/goalGrid.ts). Node workers do not
// inherit the tsx CLI's loader, so register it inside the worker before
// importing the module that answers the jobs.
import { register } from "tsx/esm/api";

register();
await import("./goalGrid.ts");
