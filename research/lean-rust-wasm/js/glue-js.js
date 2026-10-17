// Same interface as the wasm glues, backed by the plain-JS port (for parity + size comparison).
import * as L from './openx-logic.js';
export const instantiate = () => L;
