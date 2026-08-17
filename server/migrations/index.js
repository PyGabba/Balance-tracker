// Ordered list of every migration — add new ones here, in numeric id order.
// The runner enforces "not out of order" at execution time (it stops at
// the first failure rather than skipping ahead), but the list itself is
// what defines the order in the first place.
import migration001 from "./001_amount_minor_units.js";
import migration002 from "./002_household_roles.js";

export const migrations = [migration001, migration002];
