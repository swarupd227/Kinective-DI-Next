// Zod's JIT compiles validators with new Function, which the CSP forbids (spec 11.9). This has to run
// before the first schema is built, because Zod probes for it then, and the blocked probe logs an
// error on every load. So it lives here, first in this package, and is listed under sideEffects.
import { z } from 'zod';

z.config({ jitless: true });
