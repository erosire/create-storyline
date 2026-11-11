// Barrel for the store (W1). Everything the loop, the tools and the server read is here;
// `./persist` stays internal because the file layout is the store's business, not the
// caller's — the only durable contract is the Store/Collection API.
export * from './store';
