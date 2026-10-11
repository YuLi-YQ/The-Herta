/**
 * Re-export from @herta/core — V2RecordPersister moved there in v0.3
 * Slice 2 Task 4 so that @herta/app-server can use it without taking
 * a dep on @herta/cli.
 */
export {
  type ForNewSessionOpts,
  type ForResumeOpts,
  V2RecordPersister,
} from "@herta/core";
