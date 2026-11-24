// Barrel for the store (W1) and the multi-story registry (per-story storage).
//
// `./persist` stays internal by default because the file layout is the store's business, not the
// caller's — the durable contract is the Store/Collection API. The few layout names re-exported
// below are the exception, and they are public for one reason: since a story IS a folder, "which
// directory is this story's?" (harness scratch, run artifacts, the delete confirmation) is a
// question a caller has to ask, and every answer must come from the same helper so no caller
// builds a story path by hand and drifts from the layout.
export * from './store';
export * from './story-stores';
export {
    assertStoryId,
    createStoryDirectory,
    HARNESS_DIRECTORY,
    isRecordUid,
    isStoryId,
    JOURNAL_FILE,
    newRecordUid,
    newStoryId,
    recordUidAt,
    removeStoryDirectory,
    SERVER_DIRECTORY,
    STORIES_DIRECTORY,
    storyDirectoryPath,
    storyHarnessDirectoryPath,
    storiesDirectoryPath,
    STORE_FILE,
    STORY_ID_PATTERN,
    RECORD_UID_PATTERN,
    StoryLayoutError
} from './persist';
