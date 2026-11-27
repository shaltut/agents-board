// What the SessionStart hook re-injects after a compaction (#4351), in characters. One place, so the size test
// (test/role-text-size.test.ts) checks the role texts against the numbers the hook really uses (#4525).
export const CAP = 7500; // cb resume and cb role together; the hint and the guard line always print whole
export const RESUME_KEEP = 1500; // the cards keep at least this much of the block
// what cb role may print for a seat that holds cards and still come back whole: the board-wide text, the project's
// addition (cb.project_role_set caps it at 1000) and the ask-first line
export const ROLE_ROOM = CAP - RESUME_KEEP;
