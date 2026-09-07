/**
 * Bundle-only database stub for routing-policy tests.
 *
 * The tested blocked-provider paths must return before registry persistence.
 * Any accidental persistence call is therefore a test failure.
 */
function unexpectedDatabaseAccess(): never {
  throw new Error("blocked provider routing test must not access the database");
}

export const modelRegistryTable = { id: "id" };
export const db = {
  insert: unexpectedDatabaseAccess,
};